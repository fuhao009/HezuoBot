import { createHash } from "node:crypto";

/** The page stays visible during bot work; a separate native shield owns human input until takeover. */
export function createEmbeddedBrowserSurfaceManager({ owner, createNativeView, createFallbackWindow, onFallbackClose = () => {}, notify = () => {} }) {
  const profiles = new Map();
  const views = new Map();
  let binding = null;
  let disposed = false;
  let shield = null;
  const windows = new Map();
  let stopping = false;
  let activeView = null;
  const hosts = new Map();
  const move = (view, host) => {
    const previous = hosts.get(view);
    if (previous === host) return;
    if (previous && !previous.isDestroyed()) previous.contentView.removeChildView(view);
    host.contentView.addChildView(view);
    hosts.set(view, host);
  };
  const closeWindow = (entry) => {
    entry.window.hide();
    entry.binding.visible = false;
    entry.view?.setVisible(false);
    for (const [view, host] of hosts) if (host === entry.window) { view.setVisible(false); move(view, owner); }
    entry.window.destroy();
    windows.delete(entry.binding.surfaceId);
    onFallbackClose(entry.binding);
  };
  const ensureShield = () => {
    if (shield) return shield;
    shield = createNativeView({ webPreferences: { partition: `browser-input-shield-${Date.now()}`, nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true } });
    shield.setBackgroundColor("#00000000");
    shield.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    shield.webContents.on("will-navigate", (event) => event.preventDefault());
    shield.setVisible(false);
    move(shield, owner);
    void shield.webContents.loadURL("data:text/html,<html style='background:transparent'><body tabindex='0' style='margin:0;background:transparent;width:100vw;height:100vh' onkeydown='event.preventDefault()' ondragover='event.preventDefault()' ondrop='event.preventDefault()'></body></html>");
    return shield;
  };

  const state = (status = "ready") => binding && ({ surfaceId: binding.surfaceId, revision: binding.revision, status,
    visible: binding.visible && !binding.hidden && Boolean(profiles.get(binding.profileKey)?.active), interactive: binding.interactive && !binding.hidden });
  const publish = (status) => { const value = state(status); if (value) notify(value); return value; };
  const matches = (input) => binding && input?.surfaceId === binding.surfaceId && input?.revision === binding.revision;
  const hide = () => { for (const view of views.keys()) view.setVisible(false); shield?.setVisible(false); };
  const apply = () => {
    hide();
    if (disposed || stopping || owner.isDestroyed()) return;
    for (const entry of windows.values()) {
      const view = profiles.get(entry.binding.profileKey)?.active;
      entry.view = view;
      if (!view || entry.binding.hidden || !entry.binding.interactive) { entry.window.hide(); continue; }
      const [width, height] = entry.window.getContentSize();
      move(view, entry.window);
      view.setBounds({ x: 0, y: 0, width, height });
      view.setVisible(true);
    }
    const host = owner;
    const view = binding ? profiles.get(binding.profileKey)?.active : null;
    if (!view || view.webContents.isDestroyed() || [...windows.values()].some(entry => entry.view === view)) return;
    if (binding.hidden || !binding.visible || !binding.bounds) return;
    const [width, height] = host.getContentSize();
    const bounds = binding?.bounds ?? { x: 0, y: 0, width, height };
    move(view, host);
    view.setBounds(bounds);
    view.setVisible(true);
    {
      const guard = ensureShield();
      move(guard, host);
      guard.setBounds(bounds);
      host.contentView.removeChildView(guard);
      host.contentView.addChildView(guard);
      guard.setVisible(binding?.interactive !== true);
      if (binding?.interactive !== true && view.webContents.isFocused()) guard.webContents.focus();
    }
    publish();
  };
  const normalizeBounds = (bounds) => {
    if (!bounds) return null;
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) throw new Error("Invalid browser surface bounds");
    const zoom = owner.webContents.getZoomFactor();
    const [width, height] = owner.getContentSize();
    const x = Math.max(0, Math.round(bounds.x * zoom)), y = Math.max(0, Math.round(bounds.y * zoom));
    const right = Math.min(width, Math.round((bounds.x + bounds.width) * zoom));
    const bottom = Math.min(height, Math.round((bounds.y + bounds.height) * zoom));
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
  };
  const adopt = (view, profileKey) => {
    if (disposed || owner.isDestroyed()) throw new Error("Browser surface unavailable");
    view.setVisible(false);
    views.set(view, profileKey);
    let profile = profiles.get(profileKey);
    if (!profile) profiles.set(profileKey, profile = { active: null, views: new Set() });
    profile.views.add(view);
    profile.active ??= view;
    move(view, owner);
    activeView = view;
    view.webContents.on("focus", () => {
      if (!binding?.interactive && binding?.visible && profiles.get(binding.profileKey)?.active === view && ![...windows.values()].some(entry => entry.view === view)) ensureShield().webContents.focus();
    });
    view.webContents.on("destroyed", () => {
      views.delete(view);
      profile.views.delete(view);
      if (profile.active === view) profile.active = profile.views.values().next().value ?? null;
      if (activeView === view) activeView = profile.active;
      if (!profile.views.size) profiles.delete(profileKey);
      apply();
    });
    return view;
  };
  const closeView = async (view) => {
    if (!views.has(view)) return;
    view.setVisible(false);
    const host = hosts.get(view);
    if (host && !host.isDestroyed()) host.contentView.removeChildView(view);
    hosts.delete(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  };
  return {
    takeover(input, title) {
      if (disposed || !input || input.hidden || !input.interactive || !createFallbackWindow) return false;
      let entry = windows.get(input.surfaceId);
      if (!entry) {
        const window = createFallbackWindow(title);
        entry = { window, binding: input, view: null };
        windows.set(input.surfaceId, entry);
        window.on("resize", apply);
        window.on("close", event => { if (!disposed) { event.preventDefault(); closeWindow(entry); } });
      }
      apply();
      entry.window.show();
      entry.window.focus();
      entry.view?.webContents.focus();
      return true;
    },
    updateTakeover(input) {
      const entry = windows.get(input.surfaceId);
      if (!entry || entry.binding.revision !== input.revision) return;
      entry.binding = input;
      if (input.hidden || !input.interactive) closeWindow(entry);
      apply();
    },
    closeTakeover(input) {
      const entry = windows.get(input.surfaceId);
      if (entry && entry.binding.revision === input.revision) closeWindow(entry);
    },
    async createView({ profileKey, session, viewport, onPopup }) {
      if (!session) throw new Error("Isolated browser session required");
      const make = () => {
        const view = createNativeView({ webPreferences: { session, nodeIntegration: false, contextIsolation: true,
          sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
        adopt(view, profileKey);
        view.setBounds({ x: 0, y: 0, width: Math.max(1, Math.round(viewport?.width ?? 1280)), height: Math.max(1, Math.round(viewport?.height ?? 800)) });
        view.webContents.setWindowOpenHandler(() => ({ action: "allow", createWindow: () => {
          const child = make();
          try { Promise.resolve(onPopup?.(child)).catch(() => void closeView(child)); }
          catch { void closeView(child); }
          return child.webContents;
        } }));
        return view;
      };
      const view = make();
      try { await view.webContents.loadURL("about:blank"); } catch (error) { await closeView(view); throw error; }
      apply();
      return view;
    },
    adopt,
    activate(view) {
      const key = views.get(view);
      if (key === undefined) throw new Error("Unknown browser view");
      profiles.get(key).active = view;
      activeView = view;
      apply(); publish();
    },
    attach(input) {
      if (disposed || !input || typeof input.surfaceId !== "string" || !Number.isSafeInteger(input.revision) ||
          typeof input.accountKey !== "string" || typeof input.profileKey !== "string") throw new Error("Invalid browser surface binding");
      hide();
      if (binding) publish("closed");
      binding = { ...input, bounds: null, visible: false, interactive: false, hidden: input.hidden === true };
      return publish();
    },
    layout(input) {
      if (!matches(input)) return;
      binding.bounds = normalizeBounds(input.bounds);
      binding.visible = input.visible === true && binding.bounds !== null;
      apply(); publish();
    },
    setHidden(input, hidden) {
      if (!matches(input)) return;
      binding.hidden = hidden === true;
      if (binding.hidden) binding.interactive = false;
      apply(); publish();
    },
    setInteractive(input, interactive) {
      if (!matches(input)) return;
      binding.interactive = interactive === true;
      apply(); publish();
    },
    focus(input) {
      if (!matches(input) || binding.hidden || !binding.interactive || !binding.visible || !binding.bounds) return;
      profiles.get(binding.profileKey)?.active?.webContents.focus();
    },
    detach(input) {
      if (!matches(input)) return;
      hide(); publish("closed"); binding = null;
      apply();
    },
    closeView,
    async closeAll() {
      hide(); publish("closed"); binding = null;
      stopping = true;
      await Promise.all([...views.keys()].map(closeView));
      profiles.clear(); views.clear();
      if (shield) {
        const host = hosts.get(shield);
        if (host && !host.isDestroyed()) host.contentView.removeChildView(shield);
        hosts.delete(shield);
        if (!shield.webContents.isDestroyed()) shield.webContents.close({ waitForBeforeUnload: false });
        shield = null;
      }
      activeView = null;
      for (const entry of windows.values()) entry.window.destroy();
      windows.clear();
      stopping = false;
    },
    async dispose() { disposed = true; await this.closeAll(); },
  };
}

/** Session keys are opaque, account-scoped and never exposed to the renderer. */
export function embeddedBrowserPartition(accountKey, profileKey) {
  return `persist:embedded-browser-${createHash("sha256").update(accountKey).update("\0").update(profileKey).digest("hex")}`;
}
