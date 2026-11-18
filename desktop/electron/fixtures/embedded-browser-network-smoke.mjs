import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, WebContentsView, session } from "electron";
import { createEmbeddedBrowserRuntime } from "../embedded-browser-runtime.mjs";
import { installEmbeddedBrowserNetworkLogger } from "../embedded-browser-network-log.mjs";
import { setDebugLogSink } from "../debug-log.mjs";
import { targetsServer } from "../server-session.mjs";

const root = mkdtempSync(path.join(tmpdir(), "hezuo-browser-network-"));
app.setPath("userData", root);
app.setPath("sessionData", root);
app.on("window-all-closed", () => {});
const receipt = process.argv.at(-1);
const report = value => writeFileSync(receipt, JSON.stringify(value));
const records = [];
const servers = [];
const windows = [];
let logger;
// Native focus evidence only: never capture page text, URLs, cookies or account/profile keys.
let focusDiagnostic;
async function checkTakeoverFocus(window, view, owner, peers) {
  const events = [];
  const listeners = [];
  const watch = (emitter, event, source) => {
    const listener = () => {
      if (events.length === 32) events.shift();
      events.push({ source, event });
    };
    emitter.on(event, listener);
    listeners.push(() => emitter.removeListener(event, listener));
  };
  const snapshot = async (stage) => {
    const focused = BrowserWindow.getFocusedWindow();
    const state = {
      stage, appHidden: app.isHidden(), windowVisible: window.isVisible(),
      windowMinimized: window.isMinimized(), windowFocusable: window.isFocusable(),
      windowFocused: window.isFocused(), pageFocused: view.webContents.isFocused(),
      focusedWindow: focused === window ? "target" : focused === owner ? "owner"
        : peers.includes(focused) ? "peer" : focused ? "other" : "none",
    };
    // document.hasFocus is distinct from native window and WebContents focus.
    try { state.documentFocused = await view.webContents.executeJavaScript("document.hasFocus()"); }
    catch { state.documentFocused = null; }
    focusDiagnostic.samples.push(state);
  };
  focusDiagnostic = { platform: process.platform, processType: process.type,
    activationPolicy: "unchanged", samples: [], events };
  for (const event of ["activate", "did-become-active", "did-resign-active"]) watch(app, event, "app");
  for (const event of ["focus", "blur"]) {
    watch(window, event, "target-window");
    watch(view.webContents, event, "target-page");
  }
  try {
    await snapshot("before-repeat");
    return {
      async verify() {
        await snapshot("after-repeat");
        try {
          await until(() => window.isFocused() && view.webContents.isFocused());
          await snapshot("focused");
        } catch (error) {
          await snapshot("timeout");
          if (process.platform === "darwin") {
            // Failure-only probes affect this disposable Electron process, not production.
            // Keep the original failure even if a probe succeeds.
            app.focus({ steal: true });
            window.focus(); view.webContents.focus();
            await new Promise(resolve => setTimeout(resolve, 300));
            await snapshot("after-app-focus-probe");
            app.setActivationPolicy("regular");
            focusDiagnostic.activationPolicy = "regular-probe";
            app.focus({ steal: true });
            window.focus(); view.webContents.focus();
            await new Promise(resolve => setTimeout(resolve, 300));
            await snapshot("after-regular-policy-probe");
          }
          throw new Error("Repeated takeover did not focus its native window and page", { cause: error });
        }
      },
      dispose() { for (const remove of listeners) remove(); },
    };
  } catch (error) {
    for (const remove of listeners) remove();
    throw error;
  }
}
async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for network evidence");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
// Native B acceptance. Only the utility peer is fixture-owned; the runtime,
// broker, profiles, views, debugger and takeover windows are production code.
// Human 扫码 against a real site remains a separate, explicit manual step.
async function takeoverAcceptance() {
  mkdirSync(path.join(root, "browser"), { recursive: true });
  writeFileSync(path.join(root, "browser", "workspace-id"), "a".repeat(32));
  const owner = new BrowserWindow({ show: false });
  windows.push(owner);
  const nativeViews = [], takeoverWindows = [], messages = [], authorities = new Map();
  let runtime;
  runtime = createEmbeddedBrowserRuntime({
    dataDir: root, accountKey: "fixture", session,
    owner: () => owner, current: () => true, serverPort: () => 1,
    createNativeView: options => {
      const view = new WebContentsView(options);
      nativeViews.push(view);
      return view;
    },
    createFallbackWindow: title => {
      const win = new BrowserWindow({ title, width: 700, height: 500 });
      takeoverWindows.push(win); windows.push(win);
      return win;
    },
    proc: { postMessage(message) {
      messages.push(message);
      if (message.type === "hezuo:embedded-surface-resolve") {
        const authority = authorities.get(message.botId);
        assert(authority, "only fixture Bot profiles may resolve");
        queueMicrotask(() => runtime.receive({ type: "hezuo:embedded-surface-resolved",
          requestId: message.requestId, ok: true, ...authority }));
      }
    } },
  });
  try {
    for (const botId of ["alpha", "beta"]) {
      const start = nativeViews.length;
      const requestId = `open-${botId}`;
      runtime.receive({ type: "hezuo:embedded-browser-open", requestId,
        profileKey: `bot:${botId}`, egressPort: 9, viewport: { width: 700, height: 500 } });
      await until(() => messages.some(m => m.type === "hezuo:embedded-browser-open-result" && m.requestId === requestId));
      assert.equal(messages.find(m => m.type === "hezuo:embedded-browser-open-result" && m.requestId === requestId).ok, true);
      const view = nativeViews[start];
      const { targetInfo } = await view.webContents.debugger.sendCommand("Target.getTargetInfo");
      authorities.set(botId, { profileKey: `bot:${botId}`, state: {
        targetId: targetInfo.targetId, hidden: false, canOperate: true, controls: true,
      }, view });
      await view.webContents.loadURL(`data:text/html,<title>fixture</title><input id="draft">`);
      await view.webContents.executeJavaScript(`document.querySelector('#draft').value = ${JSON.stringify(botId)}`);
      // No external network/login: cookie storage is seeded through the real isolated Session.
      await view.webContents.session.cookies.set({ url: "https://fixture.invalid", name: "fixture", value: botId });
    }
    const a = authorities.get("alpha").view, b = authorities.get("beta").view;
    assert.notEqual(a.webContents.session, b.webContents.session);
    const originalId = a.webContents.id, originalSession = a.webContents.session;
    const first = await runtime.takeover({ botId: "alpha", viewerId: "fixture", title: "Alpha Bot" });
    const alphaWindow = takeoverWindows[0];
    assert.equal(alphaWindow.getTitle(), "Alpha Bot");
    assert(alphaWindow.contentView.children.includes(a));
    const second = await runtime.takeover({ botId: "beta", viewerId: "fixture", title: "Beta Bot" });
    const betaWindow = takeoverWindows[1];
    assert.equal(betaWindow.getTitle(), "Beta Bot");
    assert(betaWindow.contentView.children.includes(b));
    assert(alphaWindow.isVisible() && betaWindow.isVisible());
    const resolves = messages.filter(m => m.type === "hezuo:embedded-surface-resolve").length;
    const focusCheck = await checkTakeoverFocus(alphaWindow, a, owner, takeoverWindows);
    try {
      const repeated = await runtime.takeover({ botId: "alpha", viewerId: "fixture", title: "Alpha Bot" });
      assert.equal(repeated.surfaceId, first.surfaceId);
      assert.equal(takeoverWindows.length, 2);
      assert.equal(messages.filter(m => m.type === "hezuo:embedded-surface-resolve").length, resolves);
      await focusCheck.verify();
    } finally { focusCheck.dispose(); }
    const subscription = messages.find(m => m.type === "hezuo:embedded-surface-resolve" && m.botId === "alpha").requestId;
    alphaWindow.close();
    await until(() => alphaWindow.isDestroyed());
    assert.equal(messages.filter(m => m.type === "hezuo:embedded-surface-detach" && m.subscriptionId === subscription).length, 1,
      "native close must release the utility subscription so its control owner can resume");
    assert.equal(a.webContents.id, originalId);
    assert.equal(a.webContents.session, originalSession);
    assert(owner.contentView.children.includes(a));
    assert.equal(await a.webContents.executeJavaScript("document.querySelector('#draft').value"), "alpha");
    assert.equal((await originalSession.cookies.get({ url: "https://fixture.invalid", name: "fixture" }))[0].value, "alpha");
    assert(!b.webContents.isDestroyed());
    assert(betaWindow.isVisible());
    assert.equal((await b.webContents.session.cookies.get({ url: "https://fixture.invalid", name: "fixture" }))[0].value, "beta");
    betaWindow.close();
    const betaSubscription = messages.find(m => m.type === "hezuo:embedded-surface-resolve" && m.botId === "beta").requestId;
    await until(() => messages.some(m => m.type === "hezuo:embedded-surface-detach" && m.subscriptionId === betaSubscription));
    assert.notEqual(first.surfaceId, second.surfaceId);
    return { sameWebContents: true, profileCookiePreserved: true, focusesExisting: true,
      independentTitledWindows: true, closeReleaseIPC: true, humanScan: "manual, not exercised" };
  } finally {
    await runtime.close();
  }
}
async function run() {
  try {
    await app.whenReady();
    let blockedHits = 0;
    const blocked = await listen((_req, res) => { blockedHits++; res.end("forbidden"); });
    const origin = await listen((req, res) => {
      if (req.url === "/redirect") { res.writeHead(302, { Location: "/ok" }); res.end(); }
      else if (req.url === "/failed") req.socket.destroy();
      else if (req.url === "/slow" || req.url === "/pending") { /* Held until cancellation or disposal. */ }
      else if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end("<title>isolated network fixture</title>"); }
      else { res.writeHead(201); res.end("network fixture response body must not be logged"); }
    });
    const isolated = session.fromPath(path.join(root, "embedded"));
    const blockedPort = Number(new URL(blocked).port);
    setDebugLogSink(record => records.push(record));
    logger = installEmbeddedBrowserNetworkLogger(isolated, { shouldCancel: url => targetsServer(url, blockedPort) });
    const win = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true } });
    windows.push(win);
    await win.loadURL(origin);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const ok = await fetch('/ok', { method: 'POST', body: 'not recorded' });
      const redirected = await fetch('/redirect');
      const failed = await fetch('/failed').then(() => false, () => true);
      const blocked = await fetch(${JSON.stringify(blocked)}).then(() => false, () => true);
      const controller = new AbortController();
      const aborted = fetch('/slow', { signal: controller.signal }).then(() => false, () => true);
      setTimeout(() => controller.abort(), 100);
      return { status: ok.status, redirected: redirected.redirected, failed, blocked, aborted: await aborted };
    })()`);
    assert.deepEqual(result, { status: 201, redirected: true, failed: true, blocked: true, aborted: true });
    await until(() => records.some(r => r.url === `${origin}/slow` && r.event === "error"));
    assert.equal(blockedHits, 0);
    assert(records.some(r => r.url === `${origin}/ok` && r.method === "POST" && r.status === 201 && r.event === "response"));
    assert(records.some(r => r.url === `${origin}/redirect` && r.status === 302 && r.redirectURL === `${origin}/ok` && r.event === "redirect"));
    for (const url of [`${origin}/failed`, `${origin}/slow`, `${blocked}/`]) {
      assert(records.some(r => r.url === url && r.event === "error" && r.error.message));
    }
    for (const record of records) {
      assert.equal(record.layer, "embedded-browser->network");
      assert.equal(typeof record.requestId, "string");
      assert(record.durationMs >= 0);
      assert(!("responseBody" in record));
      assert(!("requestBody" in record));
    }
    const unrelated = new BrowserWindow({ show: false, webPreferences: { session: session.fromPath(path.join(root, "unrelated")), sandbox: true } });
    windows.push(unrelated);
    await unrelated.loadURL(`${origin}/unrelated`);
    assert(!records.some(r => r.url === `${origin}/unrelated`));
    await win.webContents.executeJavaScript("void fetch('/pending').catch(() => {})");
    await until(() => records.some(r => r.url === `${origin}/pending` && r.event === "request"));
    logger.dispose();
    logger.dispose();
    assert.equal(records.filter(r => r.url === `${origin}/pending` && r.event === "error").length, 1);
    await win.webContents.executeJavaScript(`fetch(${JSON.stringify(blocked)}).catch(() => {})`);
    assert.equal(blockedHits, 0);
    await win.webContents.executeJavaScript("fetch('/after-dispose')");
    assert(!records.some(r => r.url === `${origin}/after-dispose`));
    setDebugLogSink(null);
    const off = session.fromPath(path.join(root, "disabled"));
    const disabled = installEmbeddedBrowserNetworkLogger(off, { shouldCancel: url => targetsServer(url, blockedPort) });
    const offWin = new BrowserWindow({ show: false, webPreferences: { session: off, sandbox: true } });
    windows.push(offWin);
    await offWin.loadURL(origin);
    assert.equal(await offWin.webContents.executeJavaScript(`fetch(${JSON.stringify(blocked)}).then(() => false, () => true)`), true);
    assert.equal(blockedHits, 0);
    disabled.dispose();
    const takeover = await takeoverAcceptance();
    report({ complete: true, result, records, takeover, focusDiagnostic });
  } catch (error) {
    report({ complete: false, error: { message: error.message, stack: error.stack }, records, focusDiagnostic });
    process.exitCode = 1;
  } finally {
    logger?.dispose();
    setDebugLogSink(null);
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    for (const server of servers) { server.closeAllConnections(); server.close(); }
    rmSync(root, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
}
void run();
