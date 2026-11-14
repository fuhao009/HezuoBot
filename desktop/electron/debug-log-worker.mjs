import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createDebugLogWriter, sanitizeDebugLogRecord } from "./debug-log.mjs";

const DEFAULT_QUEUE_BYTES = 64 * 1024 * 1024;
const DEFAULT_QUEUE_RECORDS = 4096;

// Only clone data properties: getters must not execute on the main event loop.
// Count UTF-16 storage conservatively before structured cloning each record.
function snapshot(value, budget, seen = new Map()) {
  budget.bytes += 32;
  if (typeof value === "string") budget.bytes += value.length * 2;
  if (budget.bytes > budget.limit) throw new RangeError("Debug log queue capacity exceeded");
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") throw new TypeError("Unsupported debug log value");
    return value;
  }
  if (seen.has(value)) return seen.get(value);
  const result = Array.isArray(value) ? [] : {};
  if (value instanceof Error) result.name = "Error";
  seen.set(value, result);
  if (value instanceof Headers) {
    for (const [key, item] of value) result[key] = snapshot(item, budget, seen);
  } else {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (Array.isArray(value) && key === "length") continue;
      budget.bytes += key.length * 2 + 32;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      // Modern V8 exposes Error.stack as a native lazy accessor, not a data property.
      // Preserve that stack without allowing arbitrary record getters to run.
      const nativeStack = value instanceof Error && key === "stack" && typeof descriptor.get === "function"
        && Function.prototype.toString.call(descriptor.get).includes("[native code]");
      if (!("value" in descriptor) && !nativeStack) throw new TypeError("Unsupported debug log accessor");
      const item = nativeStack ? descriptor.get.call(value) : descriptor.value;
      Object.defineProperty(result, key, { value: snapshot(item, budget, seen), enumerable: true, configurable: true, writable: true });
    }
  }
  return result;
}

/** Main-owned, sole file writer. Raw records never leave this private local worker. */
export function createDebugLogWorker({ directory, maxBytes, maxQueueBytes = DEFAULT_QUEUE_BYTES,
  maxQueueRecords = DEFAULT_QUEUE_RECORDS, onError = () => {},
  createWorker = (options) => new Worker(new URL(import.meta.url), { workerData: options }),
}) {
  if (!Number.isSafeInteger(maxQueueBytes) || maxQueueBytes <= 0 || !Number.isSafeInteger(maxQueueRecords) || maxQueueRecords <= 0) {
    throw new RangeError("Invalid debug log queue capacity");
  }
  const worker = createWorker({ directory, maxBytes });
  let sequence = 0, writtenThrough = 0, outstandingBytes = 0, failure = null, closing = false, completed = false;
  let lastReceived = 0;
  const pending = new Map();
  const waiters = [];
  let resolveClosed, rejectClosed;
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  // A worker can fail before shutdown has a consumer.
  void closed.catch(() => {});
  const fail = (code, fatal = false) => {
    if (!failure) {
      failure = Object.assign(new Error(`Debug logging stopped (${code}); not all diagnostic records were saved.`), { code });
      try { onError(failure); } catch { /* Reporting must not recurse into logging. */ }
    }
    if (fatal) {
      closing = true;
      pending.clear();
      outstandingBytes = 0;
      while (waiters.length) waiters.shift().reject(failure);
      rejectClosed(failure);
      void worker.terminate();
    }
  };
  const settle = () => {
    while (waiters.length && waiters[0].through <= writtenThrough) {
      const waiter = waiters.shift();
      if (failure) waiter.reject(failure); else waiter.resolve();
    }
  };
  worker.on("message", message => {
    if (message?.type === "written" && pending.has(message.id)) {
      outstandingBytes -= pending.get(message.id);
      pending.delete(message.id);
      writtenThrough = message.id;
      settle();
    } else if (message?.type === "closed") {
      completed = true;
      if (failure) rejectClosed(failure); else resolveClosed();
    } else if (message?.type === "failed") fail("worker_write_failed", true);
  });
  worker.on("error", () => fail("worker_failed", true));
  worker.on("exit", () => { if (!completed) fail("worker_exited_before_drain", true); });
  const sink = record => {
    if (closing || failure) return false;
    try {
      if (pending.size >= maxQueueRecords) throw new RangeError("Debug log queue capacity exceeded");
      const budget = { bytes: 0, limit: maxQueueBytes - outstandingBytes };
      lastReceived = Math.max(lastReceived, Date.now());
      const received = new Date(lastReceived).toISOString();
      const data = snapshot(record, budget);
      if (data.timestamp) data.eventTimestamp ??= data.timestamp;
      data.timestamp = received;
      const id = ++sequence;
      worker.postMessage({ type: "record", id, record: data });
      pending.set(id, budget.bytes);
      outstandingBytes += budget.bytes;
      return true;
    } catch (error) {
      fail(error instanceof RangeError ? "queue_capacity_exceeded" : "record_enqueue_failed");
      // FIFO close drains all records already accepted; no synchronous fallback.
      closing = true;
      try { worker.postMessage({ type: "close", failureCode: failure.code }); }
      catch { fail("worker_failed", true); }
      return false;
    }
  };
  return {
    sink,
    flush() {
      if (failure && !pending.size) return Promise.reject(failure);
      if (!pending.size) return Promise.resolve();
      return new Promise((resolve, reject) => waiters.push({ through: sequence, resolve, reject }));
    },
    close() {
      if (!closing) { closing = true; worker.postMessage({ type: "close" }); }
      return closed;
    },
    abort() { fail("shutdown_drain_timeout", true); },
  };
}

export function runDebugLogWorker(port, options) {
  try {
    const write = createDebugLogWriter({ ...options, sanitized: true, preserveTimestamp: true });
    let stopped = false;
    port.on("message", message => {
      if (stopped) return;
      try {
        if (message.type === "record") {
          write(sanitizeDebugLogRecord(message.record));
          port.postMessage({ type: "written", id: message.id });
        } else if (message.type === "close") {
          stopped = true;
          if (message.failureCode) write(sanitizeDebugLogRecord({ timestamp: new Date().toISOString(),
            layer: "main", event: "debug-log-failure", error: { code: message.failureCode },
            message: "Diagnostic logging stopped; not all records were saved." }));
          port.postMessage({ type: "closed" });
          port.close();
        }
      } catch {
        stopped = true;
        port.postMessage({ type: "failed" });
        port.close();
      }
    });
  } catch {
    port.postMessage({ type: "failed" });
    port.close();
  }
}

if (!isMainThread && workerData?.directory && workerData?.debugLogFixture !== true) runDebugLogWorker(parentPort, workerData);
