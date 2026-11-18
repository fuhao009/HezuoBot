import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createDebugLogWorker } from "./debug-log-worker.mjs";
import { emitDebugLog, setDebugLogSink } from "./debug-log.mjs";
import { createManagedDesktopRelay } from "./managed-desktop.mjs";

function records(directory) {
  return readdirSync(directory).filter(name => /^debug(?:-\d+)?\.log$/.test(name))
    .sort((a, b) => (Number(a.match(/\d+/)?.[0]) || 0) - (Number(b.match(/\d+/)?.[0]) || 0))
    .flatMap(name => readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
}

function blocked(directory, options = {}) {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  let thread;
  const logger = createDebugLogWorker({ directory, ...options, createWorker(data) {
    thread = new Worker(new URL("./fixtures/debug-log-worker-blocked.mjs", import.meta.url), {
      workerData: { ...data, gate: gate.buffer, debugLogFixture: true },
    });
    return thread;
  } });
  return { logger, ready: once(thread, "message"), release() { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); } };
}

test("sole worker writes every accepted record in order, rotates, and redacts once", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hezuo-log-worker-"));
  const logger = createDebugLogWorker({ directory, maxBytes: 400 });
  try {
    const before = Date.now();
    for (let index = 0; index < 12; index++) assert.equal(logger.sink({
      timestamp: "2000-01-01T00:00:00.000Z", event: String(index),
      requestBody: { password: "private-password", content: "保留".repeat(40) },
      headers: new Headers({ authorization: "Bearer private-bearer" }),
      error: new Error("Authorization: Bearer private-error"),
    }), true);
    await logger.flush();
    await logger.close();
    const all = records(directory);
    assert.equal(all.length, 12);
    assert.deepEqual(all.map(record => record.event), Array.from({ length: 12 }, (_, index) => String(index)));
    assert.ok(readdirSync(directory).length > 1);
    for (const record of all) {
      assert.equal(record.eventTimestamp, "2000-01-01T00:00:00.000Z");
      assert.ok(Date.parse(record.timestamp) >= before);
      assert.equal(record.requestBody.content, "保留".repeat(40));
    }
    assert.doesNotMatch(JSON.stringify(all), /private-password|private-bearer|private-error/);
  } finally { await logger.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); }
});

test("blocked disk/redaction worker cannot delay product capability acknowledgement on main", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hezuo-log-ack-"));
  const fixture = blocked(directory);
  try {
    await fixture.ready;
    setDebugLogSink(fixture.logger.sink, { redact: false });
    const payload = `data: ${JSON.stringify({ content: "x".repeat(115725), token: "private-capability" })}\n\n`;
    for (let index = 0; index < 64; index++) emitDebugLog({ layer: "server->external", event: "chunk", responseBody: payload, index });
    let drained = false;
    const drain = fixture.logger.flush().then(() => { drained = true; });
    const relay = createManagedDesktopRelay(); // Production's unchanged 15-second acknowledgement deadline.
    const child = { postMessage(message) {
      setImmediate(() => relay.receive(child, { type: "hezuo:product-ai-result", requestId: message.requestId, ok: true }));
    } };
    await relay.sendProductAi(child, { state: "ready", connection: {
      origin: "https://operator.example", userId: "user-1", tokenId: "token-1",
      token: `hezuo_product_ai_${"a".repeat(22)}.${"b".repeat(43)}`, expiresAt: Date.now() + 900_000,
      defaultModel: "hezuo-default", models: [{ id: "hezuo-default", label: "HezuoBot", protocol: "chat", pricingVersion: "v1",
        inputMicroPointsPerMillion: 2_000_000, cachedInputMicroPointsPerMillion: 500_000,
        outputMicroPointsPerMillion: 4_000_000, maxContextTokens: 1000, maxOutputTokens: 100 }],
    } });
    assert.equal(drained, false, "capability acknowledgement finishes while the real log worker is still blocked");
    assert.deepEqual(readdirSync(directory), []);
    fixture.release();
    await drain;
    await fixture.logger.close();
    const all = records(directory);
    assert.equal(all.length, 64);
    assert.deepEqual(all.map(record => record.index), Array.from({ length: 64 }, (_, index) => index));
    assert.doesNotMatch(JSON.stringify(all), /private-capability/);
  } finally {
    setDebugLogSink(null);
    fixture.release();
    await fixture.logger.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test("queue overflow is explicit, bounded, drains accepted records and persists the failure", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hezuo-log-overload-"));
  const errors = [];
  const fixture = blocked(directory, { maxQueueRecords: 2, onError: error => errors.push(error) });
  try {
    await fixture.ready;
    assert.equal(fixture.logger.sink({ event: "first" }), true);
    assert.equal(fixture.logger.sink({ event: "second" }), true);
    assert.equal(fixture.logger.sink({ event: "rejected" }), false);
    assert.equal(fixture.logger.sink({ event: "also-rejected" }), false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "queue_capacity_exceeded");
    fixture.release();
    await assert.rejects(fixture.logger.close(), /not all diagnostic records were saved/);
    assert.deepEqual(records(directory).map(record => record.event), ["first", "second", "debug-log-failure"]);
  } finally { fixture.release(); await fixture.logger.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); }
});

test("byte bound rejects a huge record without invoking accessors or silently succeeding", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hezuo-log-bound-"));
  const errors = [];
  const logger = createDebugLogWorker({ directory, maxQueueBytes: 1024, onError: error => errors.push(error) });
  try {
    assert.equal(logger.sink({ responseBody: "x".repeat(2048), get secret() { throw new Error("must not execute"); } }), false);
    await assert.rejects(logger.close(), /queue_capacity_exceeded/);
    assert.equal(errors.length, 1);
    assert.deepEqual(records(directory).map(record => record.event), ["debug-log-failure"]);
  } finally { await logger.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); }
});

test("worker write failure rejects drain and reports a fixed message without private bodies", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hezuo-log-error-"));
  const errors = [];
  const logger = createDebugLogWorker({ directory: path.join(directory, "missing", "..", "invalid\0"), onError: error => errors.push(error) });
  try {
    logger.sink({ responseBody: "private-error-body" });
    await assert.rejects(logger.close(), /worker_write_failed/);
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0].message, /private-error-body|invalid/);
  } finally { await logger.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); }
});
