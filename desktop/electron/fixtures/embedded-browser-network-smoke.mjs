import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, session } from "electron";
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
    report({ complete: true, result, records });
  } catch (error) {
    report({ complete: false, error: { message: error.message, stack: error.stack }, records });
    process.exitCode = 1;
  } finally {
    logger?.dispose();
    setDebugLogSink(null);
    for (const win of windows) win.destroy();
    for (const server of servers) { server.closeAllConnections(); server.close(); }
    rmSync(root, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
}
void run();
