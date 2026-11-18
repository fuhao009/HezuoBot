// contextIsolation stays on: the renderer sees only window.hezuo, never Node or ipcRenderer.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Sandboxed preloads get Electron's restricted `require`, which cannot load sibling CommonJS files.
const desktopRemoteClient = process.argv.includes("--hezuo-remote-client");

let pendingPackageInstallUrl = null;
const packageInstallListeners = new Set();
ipcRenderer.on("package:install", (_event, url) => {
  if (typeof url !== "string") return;
  pendingPackageInstallUrl = url;
  for (const listener of packageInstallListeners) listener(url);
});

let pendingChatLink = null;
const chatLinkListeners = new Set();
ipcRenderer.on("chat:open", (_event, link) => {
  if (typeof link !== "string") return;
  if (!chatLinkListeners.size) {
    pendingChatLink = link;
    return;
  }
  for (const listener of chatLinkListeners) listener(link);
});

// Only fixed actions are retained, never a destination supplied by a renderer.
const FIXED_SETTINGS_ACTIONS = new Set(["organization"]);
let pendingSettingsAction = null;
const appSettingsListeners = new Set();
ipcRenderer.on("app:open-settings", (_event, section) => {
  const fixedSection = FIXED_SETTINGS_ACTIONS.has(section) ? section : undefined;
  if (fixedSection && !appSettingsListeners.size) pendingSettingsAction = fixedSection;
  if (!appSettingsListeners.size) return;
  pendingSettingsAction = null;
  for (const listener of appSettingsListeners) listener(fixedSection);
});

// The full bridge goes only to the local server's UI; a remote page gets the safe subset, and main enforces the same rule.
const localOrigin = process.argv.find((arg) => arg.startsWith("--hezuo-local-origin="))?.slice("--hezuo-local-origin=".length) ?? null;
const isLocalPage = !localOrigin || location.origin === localOrigin;

const REMOTE_SAFE = new Set(["platform", "app", "getCapabilities", "onCapabilitiesChanged", "applySkin", "setUnreadCount", "permStatus", "workspaces", "desktopNotices", "desktopAnalytics", "desktopLanguage", "windowControls", "onOpenAppSettings", "windowFrame"]);
function savedAnalyticsChoice() {
  try { const saved = ipcRenderer.sendSync("desktop-analytics:read"); return typeof saved === "boolean" ? saved : null; } catch { return null; }
}
let analyticsChoice;
function savedLanguageChoice() {
  try { const saved = ipcRenderer.sendSync("desktop-language:read"); return typeof saved === "string" ? saved : null; } catch { return null; }
}
let languageChoice;
const languageListeners = new Set();
ipcRenderer.on("desktop-language:changed", (_event, language) => {
  if (typeof language !== "string") return;
  languageChoice = language;
  for (const listener of languageListeners) listener(language);
});
const remoteKeys = REMOTE_SAFE;

// Keep in parity with shared/workspace-backup-client.ts (a sandboxed preload cannot import it).
const COMPANY_BACKUP_CLIENT_KEYS = [
  "hezuo-drafts", "hezuo-draft-attachments", "hezuo-draft-send-ids", "hezuo-draft-channel-modes",
  "hezuo-skin", "hezuo-show-threads", "hezuo-show-run-card", "hezuo-send-key", "hezuo-color-user-bubbles", "hezuo-chat-width", "hezuo.sidebarDensity",
  "hezuo.sidebarToolsLayout",
  "hezuo.sidebarCollapsedSections.v1", "hezuo.sidebarSectionOrder.v1",
  "hezuo-analytics-opt-out", "hezuo.remote-voice.v1",
];
if (isLocalPage && !desktopRemoteClient && process.argv.includes("--hezuo-company-desktop=1")) {
  ipcRenderer.on("company-backups:collect-client-state", (_event, request) => {
    if (!request || typeof request.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(request.requestId)) return;
    try {
      // Check the origin again; a later navigation must not export remote data.
      if (!localOrigin || location.origin !== localOrigin) throw new Error("Not the local workspace");
      const clientState = {};
      for (const key of COMPANY_BACKUP_CLIENT_KEYS) {
        const value = localStorage.getItem(key);
        if (value !== null) clientState[key] = value;
      }
      if (new TextEncoder().encode(JSON.stringify(clientState)).byteLength > 2 * 1024 ** 2) throw new Error("Browser state too large");
      ipcRenderer.send("company-backups:client-state", { requestId: request.requestId, clientState });
    } catch {
      ipcRenderer.send("company-backups:client-state", { requestId: request.requestId, unavailable: true });
    }
  });
}

// main passes app.getVersion(): a server's page carries that server's version, so About asks this for the app's own.
const appVersion = (process.argv.find((arg) => arg.startsWith("--hezuo-app-version="))?.slice("--hezuo-app-version=".length) ?? "").slice(0, 64);

const bridge = {
  platform: process.platform,
  /** This app's version, and whether this page is this app's own (served by this computer, not a server from the Server menu). */
  app: { version: appVersion, ownPage: isLocalPage },
  // A managed product build's workspace: the person's own account state and
  // history, never an account bearer, model token, upstream address or data
  // directory. Arguments are text only; main re-checks the exact page and
  // holds no long-lived permission in this bridge.
  productAccount: isLocalPage && process.argv.includes("--hezuo-product-managed=1") ? {
    state: () => ipcRenderer.invoke("product-account:state"),
    requestCode: (email) => ipcRenderer.invoke("product-account:request-code", typeof email === "string" ? email.slice(0, 254) : ""),
    verifyCode: (email, code) => ipcRenderer.invoke("product-account:verify-code",
      typeof email === "string" ? email.slice(0, 254) : "", typeof code === "string" ? code.slice(0, 8) : ""),
    methods: () => ipcRenderer.invoke("product-account:methods"),
    signInWithPassword: (email, password) => ipcRenderer.invoke("product-account:sign-in-password",
      typeof email === "string" ? email.slice(0, 254) : "", typeof password === "string" ? password.slice(0, 129) : ""),
    signUp: (email, password) => ipcRenderer.invoke("product-account:sign-up",
      typeof email === "string" ? email.slice(0, 254) : "", typeof password === "string" ? password.slice(0, 129) : ""),
    confirmEmail: (email, code, password) => ipcRenderer.invoke("product-account:confirm-email",
      typeof email === "string" ? email.slice(0, 254) : "", typeof code === "string" ? code.slice(0, 8) : "",
      typeof password === "string" ? password.slice(0, 129) : ""),
    requestPasswordReset: (email) => ipcRenderer.invoke("product-account:request-password-reset",
      typeof email === "string" ? email.slice(0, 254) : ""),
    resetPassword: (email, code, password) => ipcRenderer.invoke("product-account:reset-password",
      typeof email === "string" ? email.slice(0, 254) : "", typeof code === "string" ? code.slice(0, 8) : "",
      typeof password === "string" ? password.slice(0, 129) : ""),
    refresh: () => ipcRenderer.invoke("product-account:refresh"),
    operatorStatus: () => ipcRenderer.invoke("product-account:operator-status"),
    grantMaximum: () => ipcRenderer.invoke("product-account:grant-maximum"),
    ledger: (cursor) => ipcRenderer.invoke("product-account:ledger", ...(cursor === undefined ? [] : [typeof cursor === "string" ? cursor.slice(0, 256) : ""])),
    signOut: () => ipcRenderer.invoke("product-account:sign-out"),
    onState: (cb) => {
      if (typeof cb !== "function") return () => {};
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("product-account:state-changed", handler);
      return () => ipcRenderer.removeListener("product-account:state-changed", handler);
    },
  } : undefined,
  // Native workspace navigation; main enforces which destinations this page may open.
  workspaces: {
    state: () => ipcRenderer.invoke("workspaces:state"),
    menu: (options) => ipcRenderer.invoke("workspaces:menu", ...(options?.from === "howto" ? ["howto"] : [])),
    add: (choice, link) => {
      if (choice !== "link" && choice !== "address") return Promise.reject(new Error("Choose a server link or address."));
      return isLocalPage || navigator.userActivation?.isActive === true
        ? ipcRenderer.invoke("workspaces:add", choice, ...(typeof link === "string" ? [link] : [])) : Promise.reject(new Error("Choose what to add."));
    },
  },
  // The window's own frame, this desktop's choice for every page of its window; a server's page changes it only from the
  // person's click.
  windowFrame: {
    state: () => ipcRenderer.invoke("window-frame:state"),
    set: (on) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("window-frame:set", on === true) : Promise.reject(new Error("Choose to turn the window frame on or off.")),
  },
  getCapabilities: () => ipcRenderer.invoke("desktop:capabilities"),
  onCapabilitiesChanged: (cb) => {
    const handler = (_event, capabilities) => cb(capabilities);
    ipcRenderer.on("desktop:capabilities-changed", handler);
    return () => ipcRenderer.removeListener("desktop:capabilities-changed", handler);
  },
  /** The bearer stays in the main process and is never returned over this bridge. */
  remoteClient: {
    active: desktopRemoteClient,
    state: () => ipcRenderer.invoke("desktop-remote:state"),
    pair: (endpoint, code) => ipcRenderer.invoke("desktop-remote:pair", endpoint, code),
    disconnect: () => ipcRenderer.invoke("desktop-remote:disconnect"),
  },
  companion: {
    state: () => ipcRenderer.invoke("companion:state"),
    start: () => ipcRenderer.invoke("companion:start"),
    stop: () => ipcRenderer.invoke("companion:stop"),
    keepAwake: (enabled) => ipcRenderer.invoke("companion:keep-awake", enabled),
    refreshTailscale: () => ipcRenderer.invoke("companion:refresh-tailscale"),
    pairing: (open, expectedToken) => ipcRenderer.invoke("companion:pairing", open, expectedToken),
    cloudDesktop: (deviceId, allowed) => ipcRenderer.invoke("companion:cloud-desktop", deviceId, allowed),
    browserControl: (deviceId, allowed) => ipcRenderer.invoke("companion:browser-control", deviceId, allowed),
    revoke: (deviceId) => ipcRenderer.invoke("companion:revoke", deviceId),
  },
  routines: {
    wakeState: () => ipcRenderer.invoke("routines:wake-state"),
    keepAwake: (enabled) => ipcRenderer.invoke("routines:keep-awake", enabled),
  },
  /** Full/Custom never go through the loopback API, only the embedded server's private utilityProcess port. */
  approvals: {
    setMode: (botId, mode, options) => ipcRenderer.invoke("approvals:set-trusted-mode", botId, mode, options),
  },
  computerUsePolicy: {
    get: () => ipcRenderer.invoke("computer-use-policy:get"),
    set: (policy) => ipcRenderer.invoke("computer-use-policy:set", policy),
  },
  localControl: {
    status: () => ipcRenderer.invoke("cua:linux-status"),
    enable: () => ipcRenderer.invoke("cua:linux-enable"),
    disable: () => ipcRenderer.invoke("cua:linux-disable"),
    retry: () => ipcRenderer.invoke("cua:linux-retry"),
  },
  /** Arms exactly one display-media request from the current renderer frame. */
  beginScreenPreviewIntent: () => ipcRenderer.sendSync("screen:preview-intent"),
  screenFrame: () => ipcRenderer.invoke("screen:frame"),
  /** Physical USB devices only; network ADB is deliberately excluded. */
  androidDevice: {
    status: () => ipcRenderer.invoke("android-device:status"),
    frame: (serial) => ipcRenderer.invoke("android-device:frame", serial),
    input: (serial, payload) =>
      ipcRenderer.invoke("android-device:input", serial, payload).then(() => undefined),
  },
  speechStart: (options) => ipcRenderer.invoke("speech:start", options),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  speechFinish: () => ipcRenderer.invoke("speech:finish"),
  onSpeechTranscript: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on("speech:transcript", handler);
    return () => ipcRenderer.removeListener("speech:transcript", handler);
  },
  onSpeechEnd: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on("speech:end", handler);
    return () => ipcRenderer.removeListener("speech:end", handler);
  },
  talkShortcut: {
    state: () => ipcRenderer.invoke("talk-shortcut:state"),
    set: (change) => ipcRenderer.invoke("talk-shortcut:set", {
      ...(typeof change?.enabled === "boolean" ? { enabled: change.enabled } : {}),
      ...(typeof change?.key === "string" ? { key: change.key } : {}),
    }),
  },
  callActive: (active) => ipcRenderer.invoke("call:active", active === true).then(() => undefined),
  onOpenAppSettings: (cb) => {
    appSettingsListeners.add(cb);
    queueMicrotask(() => {
      const section = pendingSettingsAction;
      if (!section || !appSettingsListeners.size) return;
      pendingSettingsAction = null;
      for (const listener of appSettingsListeners) listener(section);
    });
    return () => appSettingsListeners.delete(cb);
  },
  /** Electron 32 removed File.path, and only the preload can ask. */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** No screen field: macOS 15+ caches that status per process, so it would lie after a grant. */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),
  relaunch: () => ipcRenderer.invoke("desktop:relaunch"),

  openInstallTerminal: (command) => ipcRenderer.invoke("engine:open-terminal", command),
  copyText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  /** Unlike window.open, this still works after an asynchronous API request. */
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  applySkin: (skin) => ipcRenderer.invoke("desktop:skin", skin),
  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    state: () => ipcRenderer.invoke("window:state"),
    onMaximizedChanged: (cb) => {
      const handler = (_event, maximized) => cb(maximized);
      ipcRenderer.on("window:maximized-changed", handler);
      return () => ipcRenderer.removeListener("window:maximized-changed", handler);
    },
  },
  onPackageInstall: (cb) => {
    packageInstallListeners.add(cb);
    if (pendingPackageInstallUrl) cb(pendingPackageInstallUrl);
    return () => packageInstallListeners.delete(cb);
  },
  onChatLink: (cb) => {
    chatLinkListeners.add(cb);
    if (pendingChatLink) {
      const link = pendingChatLink;
      pendingChatLink = null;
      cb(link);
    }
    return () => chatLinkListeners.delete(cb);
  },
  setUnreadCount: (count) => ipcRenderer.send("desktop:unread-count", count),
  desktopViewer: {
    open: (url, title, contextId) => ipcRenderer.invoke("desktop-viewer:open", url, title, contextId),
    close: (contextId) => ipcRenderer.invoke("desktop-viewer:close", contextId),
    currentState: () => ipcRenderer.invoke("desktop-viewer:state-now"),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-viewer:state", handler);
      return () => ipcRenderer.removeListener("desktop-viewer:state", handler);
    },
  },
  browserSurface: {
    attach: (input) => ipcRenderer.invoke("browser-surface:attach", input),
    takeover: (input) => ipcRenderer.invoke("browser-surface:takeover", input),
    closeTakeover: (input) => ipcRenderer.invoke("browser-surface:close-takeover", input),
    layout: (input) => ipcRenderer.invoke("browser-surface:layout", input),
    focus: (input) => ipcRenderer.invoke("browser-surface:focus", input),
    detach: (input) => ipcRenderer.invoke("browser-surface:detach", input),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("browser-surface:state", handler);
      return () => ipcRenderer.removeListener("browser-surface:state", handler);
    },
  },
  desktopWorkspace: {
    open: (input) => ipcRenderer.invoke("desktop-workspace:open", input),
    layout: (items) => ipcRenderer.invoke("desktop-workspace:layout", items),
    setInteractive: (contextId) => ipcRenderer.invoke("desktop-workspace:set-interactive", contextId),
    close: (contextId) => ipcRenderer.invoke("desktop-workspace:close", contextId),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-workspace:state", handler);
      return () => ipcRenderer.removeListener("desktop-workspace:state", handler);
    },
  },
  pickFolder: (current) => ipcRenderer.invoke("desktop:pick-folder", current),
  exportDiagnostics: () => ipcRenderer.invoke("desktop:export-diagnostics"),
  /** ipcRenderer wraps a main-process throw in "Error invoking remote method"; the bubble shows the text verbatim. */
  saveFile: (filePath) =>
    ipcRenderer.invoke("desktop:save-file", filePath).catch((error) => {
      const message = String(error?.message ?? error);
      throw new Error(message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    }),
  revealInFolder: (filePath) => ipcRenderer.invoke("desktop:reveal-file", filePath),
  // This app's own logs folder (server.log, desktop-crashes.log); the page names no path.
  openLogsFolder: () => ipcRenderer.invoke("desktop:open-logs"),
  openAtLogin: {
    state: () => ipcRenderer.invoke("open-at-login:state"),
    set: on => on !== true || isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("open-at-login:set", on === true) : Promise.reject(new Error("Turn on the switch to open HezuoBot at login.")),
  },
  setCredential: (name, value) => ipcRenderer.invoke("credential:set", name, value),


  /** A remote page may read the list but never change where this window goes. */
  environments: {
    state: () => ipcRenderer.invoke("environments:state"),
    switch: (id) => ipcRenderer.invoke("environments:switch", id),
    addFromLink: (link, name) => ipcRenderer.invoke("environments:add-from-link", link, name),
    create: (name, dataDir) => ipcRenderer.invoke("environments:create", name, dataDir),
    pickDir: () => ipcRenderer.invoke("environments:pick-dir"),
    forget: (id, purge) => ipcRenderer.invoke("environments:forget", id, purge === true),
    onOpenSettings: (cb) => {
      const handler = (_event, computerId) => cb(computerId);
      ipcRenderer.on("workspaces:open-settings", handler);
      return () => ipcRenderer.removeListener("workspaces:open-settings", handler);
    },
  },
  organization: process.argv.includes("--hezuo-company-desktop=1") ? {
    settingsOpened: () => ipcRenderer.invoke("organization:settings-opened"),
    state: () => ipcRenderer.invoke("organization:state"),
    begin: input => ipcRenderer.invoke("organization:begin", input),
    reopen: () => ipcRenderer.invoke("organization:reopen"),
    cancelEnrollment: () => ipcRenderer.invoke("organization:cancel"),
    refresh: () => ipcRenderer.invoke("organization:refresh"),
    disconnect: () => ipcRenderer.invoke("organization:disconnect"),
    onState: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("organization:state-changed", handler);
      return () => ipcRenderer.removeListener("organization:state-changed", handler);
    },
  } : undefined,
  companyBackups: process.argv.includes("--hezuo-company-desktop=1") ? {
    state: () => ipcRenderer.invoke("company-backups:state"),
    list: () => ipcRenderer.invoke("company-backups:list"),
    create: input => ipcRenderer.invoke("company-backups:create", input),
    configureSchedule: input => ipcRenderer.invoke("company-backups:configure-schedule", input),
    prepareRestore: input => ipcRenderer.invoke("company-backups:preview", input),
    restore: input => ipcRenderer.invoke("company-backups:restore", input),
    delete: input => ipcRenderer.invoke("company-backups:delete", input),
    cancel: () => ipcRenderer.invoke("company-backups:cancel"),
    onState: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("company-backups:state-changed", handler);
      return () => ipcRenderer.removeListener("company-backups:state-changed", handler);
    },
  } : undefined,
  computerSharing: {
    state: id => ipcRenderer.invoke("sharing:state", id),
    chooseFolder: () => ipcRenderer.invoke("sharing:folder"),
    save: (id, grant) => ipcRenderer.invoke("sharing:save", id, grant),
    revoke: id => ipcRenderer.invoke("sharing:revoke", id),
    activity: id => ipcRenderer.invoke("sharing:activity", id),
  },
  confirm: message => ipcRenderer.invoke("dialog:confirm", message),
  desktopProfile: {
    systemName: () => ipcRenderer.invoke("desktop-profile:system-name"),
  },
  desktopNotices: {
    state: () => ipcRenderer.invoke("desktop-notices:state"),
    seen: id => ipcRenderer.invoke("desktop-notices:seen", String(id)),
    // A Cloud or server page on 0.1.135 or older calls this as its Cloud Pro popup opens, and the whole page went blank
    // when it was missing. Nothing asks main any more: never the first showing today, so that page reports nothing.
    shown: () => Promise.resolve(false),
  },
  desktopAnalytics: {
    enabled: () => {
      if (analyticsChoice === undefined) analyticsChoice = savedAnalyticsChoice();
      return analyticsChoice;
    },
    ...(isLocalPage ? { set: enabled => { analyticsChoice = enabled === true; return ipcRenderer.invoke("desktop-analytics:set", analyticsChoice); } } : {}),
  },
  desktopLanguage: {
    choice: () => {
      if (languageChoice === undefined) languageChoice = savedLanguageChoice();
      return languageChoice;
    },
    set: language => {
      languageChoice = String(language);
      return ipcRenderer.invoke("desktop-language:set", languageChoice);
    },
    onChange: listener => {
      languageListeners.add(listener);
      return () => { languageListeners.delete(listener); };
    },
  },
};

contextBridge.exposeInMainWorld(
  "hezuo",
  isLocalPage ? bridge : Object.fromEntries(Object.entries(bridge).filter(([key]) => remoteKeys.has(key))),
);
