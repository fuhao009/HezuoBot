import "../debug-main-bootstrap.mjs";
import "./debug-main-registration.mjs";
import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain } from "electron";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setDebugLogSink } from "../debug-log.mjs";

const root = mkdtempSync(path.join(tmpdir(), "hezuo-debug-main-smoke-"));
app.setPath("userData", root);
app.setPath("sessionData", root);
app.on("window-all-closed", () => {});
const receipt = process.argv.at(-1);
const report = value => writeFileSync(receipt, JSON.stringify(value));
report({ phase: "module-evaluated" });
const records = [];
setDebugLogSink(record => records.push(record));
// Electron waits for an ESM entry's top-level evaluation before emitting ready.
// Do not await readiness at module scope: that makes startup wait on itself.
async function run() {
let win;
try {
  await app.whenReady();
  report({ phase: "ready" });
  let removed = 0;
  const listener = () => { removed++; };
  ipcMain.once("debug-smoke:removed", listener);
  ipcMain.removeListener("debug-smoke:removed", listener);
  ipcMain.emit("debug-smoke:removed", {});
  assert.equal(removed, 0);
  let once = 0;
  ipcMain.once("debug-smoke:once", () => { once++; });
  ipcMain.emit("debug-smoke:once", {});
  ipcMain.emit("debug-smoke:once", {});
  assert.equal(once, 1);
  win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  await win.loadURL("data:text/html,<title>isolated debug smoke</title>");
  report({ phase: "page-loaded" });
  const result = await win.webContents.executeJavaScript(`(async () => {
    const { ipcRenderer } = require('electron');
    const value = await ipcRenderer.invoke('debug-smoke:import-time', { content: 'hello' });
    const sync = ipcRenderer.sendSync('debug-smoke:sync');
    globalThis.debugPush = new Promise(resolve => ipcRenderer.once('debug-smoke:push', (_event, value) => resolve(value)));
    return { value, sync };
  })()`);
  assert.deepEqual(result, { value: { content: "hello" }, sync: false });
  report({ phase: "renderer-ipc", result });
  win.webContents.send("debug-smoke:push", { content: "pushed" });
  assert.deepEqual(await win.webContents.executeJavaScript("globalThis.debugPush"), { content: "pushed" });
  for (const url of ["debug-smoke:import-time", "debug-smoke:sync", "debug-smoke:push"]) {
    assert.equal(records.filter(record => record.url === url && record.event === "request").length, 1);
    assert.equal(records.filter(record => record.url === url && record.event === "response").length, 1);
  }
  assert.equal(records.find(record => record.url === "debug-smoke:sync" && record.event === "response").responseBody, false);
  report({ complete: true, result, records });
} catch (error) {
  report({ complete: false, error: { message: error.message, stack: error.stack } });
  process.exitCode = 1;
} finally {
  setDebugLogSink(null);
  win?.destroy();
  rmSync(root, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
}
}
void run();
