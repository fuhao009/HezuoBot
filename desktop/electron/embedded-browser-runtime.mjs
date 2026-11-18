import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createEmbeddedBrowserBroker } from "./embedded-browser-cdp.mjs";
import { createEmbeddedBrowserSurfaceManager } from "./embedded-browser-surface.mjs";
import { targetsServer } from "./server-session.mjs";
import { installEmbeddedBrowserNetworkLogger } from "./embedded-browser-network-log.mjs";

/** One private browser runtime per utility child; renderer messages carry no profile authority. */
export function createEmbeddedBrowserRuntime({ proc, dataDir, accountKey, session, createNativeView, createFallbackWindow, owner, current, serverPort }) {
  let closed = false, manager = null, window = null, binding = null, revision = 0, attachment = 0;
  const pending = new Map();
  const latestStates = new Map();
  const takeovers = new Map();
  const finishTakeover = value => {
    if (!takeovers.delete(value.surfaceId)) return;
    send({ type: "hezuo:embedded-surface-detach", subscriptionId: value.subscriptionId });
    if (window && !window.isDestroyed()) window.webContents.send("browser-surface:state", { surfaceId: value.surfaceId, revision: value.revision, status: value.failure || value.hidden || !value.interactive ? "error" : "closed", visible: false, interactive: false });
  };
  const send = message => { if (current()) proc.postMessage(message); };
  function surface() {
    const win = owner();
    if (!win || win.isDestroyed() || closed || !current()) throw new Error("Browser window unavailable");
    if (!manager) {
      window = win;
      manager = createEmbeddedBrowserSurfaceManager({ owner: win, createNativeView, createFallbackWindow, onFallbackClose: finishTakeover,
        notify: value => { if (!closed && current() && !win.isDestroyed()) win.webContents.send("browser-surface:state", value); } });
      win.once("closed", () => { void closeViews().finally(async () => { await manager?.dispose(); manager = null; window = null; }); });
      win.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => { if (mainFrame) detach(); });
    }
    if (window !== win) throw new Error("Browser owner changed");
    return manager;
  }
  const broker = createEmbeddedBrowserBroker({
    createView: input => surface().createView(input), activate: view => surface().activate(view),
    closeView: view => manager?.closeView(view), send,
    version: () => ({ product: `Chrome/${process.versions.chrome}`, revision: "", userAgent: "", protocolVersion: "1.3" }),
    async sessionFor(key, { egressPort }) {
      if (closed || !current() || !/^(bot|shared|temp|mychrome|cdp):[A-Za-z0-9._:@-]{1,200}$/.test(key)) throw new Error("Browser profile unavailable");
      const root = path.join(dataDir, "browser");
      // The server creates this identity before opening its backend. Never invent a competing identity.
      const workspace = (await fs.readFile(path.join(root, "workspace-id"), "utf8")).trim();
      if (!/^[0-9a-f]{32}$/.test(workspace)) throw new Error("Invalid workspace identity");
      const hash = createHash("sha256").update(workspace).update("\0").update(key).digest("hex").slice(0, 24);
      const dir = path.join(root, key.startsWith("temp:") ? "temp" : "profiles", hash);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const isolated = session.fromPath(path.join(dir, "electron"));
      const networkLog = installEmbeddedBrowserNetworkLogger(isolated, { shouldCancel: url => targetsServer(url, serverPort()) });
      try {
        await isolated.setProxy({ mode: "fixed_servers", proxyRules: `socks5://127.0.0.1:${egressPort}`, proxyBypassRules: "<-loopback>" });
        await isolated.closeAllConnections();
        if (closed || !current()) throw new Error("Browser runtime changed");
        const manifest = path.join(dir, "electron-tabs.json");
        let restoreTabs = null;
        try { restoreTabs = JSON.parse(await fs.readFile(manifest, "utf8")); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
        return { session: isolated, downloadDir: path.join(root, "downloads", hash), restoreTabs, release: () => networkLog.dispose(),
          async saveTabs(snapshot) {
            const temp = `${manifest}.${randomUUID()}.tmp`;
            await fs.writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
            await fs.rename(temp, manifest);
          } };
      } catch (error) {
        networkLog.dispose();
        throw error;
      }
    },
  });
  function detach(input) {
    if (input && (!binding || input.surfaceId !== binding.surfaceId || input.revision !== binding.revision)) return;
    attachment++;
    if (binding) { manager?.detach(binding); send({ type: "hezuo:embedded-surface-detach", subscriptionId: binding.subscriptionId }); binding = null; }
    for (const [requestId, request] of pending) {
      send({ type: "hezuo:embedded-surface-detach", subscriptionId: requestId });
      clearTimeout(request.timer); request.reject(new Error("Browser surface detached"));
    }
    pending.clear();
    latestStates.clear();
  }
  async function attach(input, independent = false) {
    if (!independent) detach();
    const attempt = attachment;
    if (!input || typeof input.botId !== "string" || typeof input.viewerId !== "string" || input.threadId !== undefined && typeof input.threadId !== "string") throw new Error("Invalid browser viewer");
    if (independent) {
      const existing = [...takeovers.values()].find(value => value.botId === input.botId && value.viewerId === input.viewerId);
      if (existing && surface().takeover(existing, input.title)) return { surfaceId: existing.surfaceId, revision: existing.revision, status: "ready", visible: true, interactive: true };
    }
    const requestId = randomUUID();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Browser viewer unavailable")); }, 10000);
      pending.set(requestId, { resolve, reject, timer });
      send({ type: "hezuo:embedded-surface-resolve", requestId, botId: input.botId, threadId: input.threadId, viewerId: input.viewerId });
    });
    if (closed || !current() || !independent && attempt !== attachment || !result.profileKey || !result.state) {
      send({ type: "hezuo:embedded-surface-detach", subscriptionId: requestId });
      latestStates.delete(requestId);
      throw new Error("Browser viewer unavailable");
    }
    if (latestStates.has(requestId)) result.state = latestStates.get(requestId);
    try {
      if (!result.state) throw new Error("Browser viewer closed");
      const profileKey = result.profileKey;
      while (true) {
        const targetId = result.state.targetId;
        if (!await broker.activateTarget(profileKey, targetId)) throw new Error("Browser tab unavailable");
        result.state = latestStates.get(requestId);
        if (closed || !current() || !independent && attempt !== attachment || !result.state) throw new Error("Browser viewer closed");
        if (independent && (result.state.hidden || !result.state.canOperate || !result.state.controls)) throw new Error("Browser control required");
        if (result.state.targetId === targetId) break;
      }
      const next = { surfaceId: randomUUID(), revision: ++revision, accountKey, profileKey, subscriptionId: requestId, hidden: result.state.hidden === true, authority: result.state, botId: input.botId, viewerId: input.viewerId };
    if (independent) {
      next.interactive = result.state.canOperate === true && result.state.controls === true && !next.hidden;
      if (!next.interactive) {
        send({ type: "hezuo:embedded-surface-detach", subscriptionId: requestId });
        throw new Error("Browser control required");
      }
      takeovers.set(next.surfaceId, next);
      if (!surface().takeover(next, input.title)) { finishTakeover(next); throw new Error("Browser window unavailable"); }
      return { surfaceId: next.surfaceId, revision: next.revision, status: "ready", visible: true, interactive: true };
    }
    binding = next;
    const state = surface().attach(binding);
    surface().setInteractive(binding, binding.authority.canOperate === true && binding.authority.controls === true && !binding.hidden);
    return state;
    } catch (error) {
      send({ type: "hezuo:embedded-surface-detach", subscriptionId: requestId });
      throw error;
    } finally { latestStates.delete(requestId); }
  }
  function receive(message) {
    if (closed || !current()) return false;
    if (message?.type === "hezuo:embedded-surface-resolved") {
      const request = pending.get(message.requestId);
      if (!request) { send({ type: "hezuo:embedded-surface-detach", subscriptionId: message.requestId }); return true; }
      pending.delete(message.requestId); clearTimeout(request.timer);
      if (message.ok) { latestStates.set(message.requestId, message.state); request.resolve(message); } else request.reject(new Error("Browser viewer unavailable"));
      return true;
    }
    if (message?.type === "hezuo:embedded-surface-state") {
      if (pending.has(message.subscriptionId) || latestStates.has(message.subscriptionId)) latestStates.set(message.subscriptionId, message.state);
      for (const value of takeovers.values()) {
        if (value.subscriptionId !== message.subscriptionId) continue;
        const authority = message.state;
        value.hidden = !authority || authority.hidden === true;
        value.interactive = authority?.canOperate === true && authority.controls === true && !value.hidden;
        manager?.updateTakeover(value);
        if (authority && value.interactive) void broker.activateTarget(value.profileKey, authority.targetId);
      }
      if (binding?.subscriptionId === message.subscriptionId) {
        if (!message.state) void closeViews();
        else {
          binding.authority = message.state;
          binding.hidden = message.state.hidden === true;
          const owned = binding;
          void broker.activateTarget(owned.profileKey, message.state.targetId).then(ok => { if (!ok && binding === owned) void closeViews(); }, () => { if (binding === owned) void closeViews(); });
          manager?.setHidden(binding, message.state.hidden === true);
          manager?.setInteractive(binding, message.state.canOperate === true && message.state.controls === true && message.state.hidden !== true);
        }
      }
      return true;
    }
    if (typeof message?.type === "string" && message.type.startsWith("hezuo:embedded-browser-")) { void broker.receive(message).catch(() => void close()); return true; }
    return false;
  }
  async function closeViews() {
    for (const value of takeovers.values()) { value.failure = true; manager?.closeTakeover(value); finishTakeover(value); }
    detach();
    try { await broker.closeLeases(); } finally { await manager?.closeAll(); }
  }
  async function close() {
    if (closed) return;
    for (const value of takeovers.values()) { value.failure = true; manager?.closeTakeover(value); finishTakeover(value); }
    detach(); closed = true;
    try { await broker.close(); } finally { await manager?.dispose(); }
  }
  return { receive, attach, close, takeover: input => attach(input, true),
    closeTakeover: input => manager?.closeTakeover(input),
    layout: input => manager?.layout(input), focus: input => manager?.focus(input), detach };
}
