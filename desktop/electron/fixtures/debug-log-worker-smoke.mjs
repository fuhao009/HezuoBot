import assert from "node:assert/strict";
import { app } from "electron";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDebugLogWorker } from "../debug-log-worker.mjs";
import { emitDebugLog, setDebugLogSink } from "../debug-log.mjs";

const root = mkdtempSync(path.join(tmpdir(), "hezuo-debug-worker-electron-"));
app.setPath("userData", root);
app.setPath("sessionData", root);
app.on("window-all-closed", () => {});
const receipt = process.argv.at(-1);
const report = value => writeFileSync(receipt, JSON.stringify(value));
report({ phase: "module-evaluated" });
let logger;
let draining = false;
let drained = false;
let failed = false;

app.on("before-quit", event => {
  if (drained) return;
  event.preventDefault();
  if (draining) return;
  draining = true;
  setDebugLogSink(null);
  void (async () => {
    try {
      await logger.close();
      const directory = path.join(root, "logs");
      const files = readdirSync(directory).filter(name => /^debug(?:-\d+)?\.log$/.test(name))
        .sort((a, b) => (Number(a.match(/\d+/)?.[0]) || 0) - (Number(b.match(/\d+/)?.[0]) || 0));
      const records = files.flatMap(name => readFileSync(path.join(directory, name), "utf8").trim().split("\n").map(JSON.parse));
      assert.ok(files.length > 1);
      assert.deepEqual(records.map(record => record.index), Array.from({ length: 20 }, (_, index) => index));
      assert.doesNotMatch(JSON.stringify(records), /fixture-private-password|fixture-private-bearer/);
      assert.ok(records.every(record => record.eventTimestamp === "2000-01-01T00:00:00.000Z"));
      report({ complete: true, count: records.length, rotatedFiles: files.length, shutdownDrained: true });
    } catch (error) {
      failed = true;
      report({ complete: false, phase: "shutdown-drain", error: { message: error.message, stack: error.stack } });
    } finally {
      drained = true;
      rmSync(root, { recursive: true, force: true });
      if (failed) app.exit(1); else app.quit();
    }
  })();
});

async function run() {
  try {
    await app.whenReady();
    report({ phase: "ready" });
    logger = createDebugLogWorker({ directory: path.join(root, "logs"), maxBytes: 700,
      onError() { failed = true; } });
    setDebugLogSink(logger.sink, { redact: false });
    for (let index = 0; index < 10; index++) emitDebugLog({ timestamp: "2000-01-01T00:00:00.000Z", index,
      requestBody: { password: "fixture-private-password", content: "保留".repeat(40) },
      headers: new Headers({ authorization: "Bearer fixture-private-bearer" }) });
    await logger.flush();
    report({ phase: "first-flush" });
    // The second half must be persisted by the actual before-quit drain, not a preceding flush.
    for (let index = 10; index < 20; index++) emitDebugLog({ timestamp: "2000-01-01T00:00:00.000Z", index,
      responseBody: { password: "fixture-private-password", content: "保留".repeat(40) } });
    app.quit();
  } catch (error) {
    report({ complete: false, phase: "run", error: { message: error.message, stack: error.stack } });
    setDebugLogSink(null);
    if (logger) await logger.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    app.exit(1);
  }
}
void run();
