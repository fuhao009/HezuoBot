import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installMainDebug, installMainIpcDebug, instrumentUtilityProcessDebug, instrumentWebContentsDebug, utilityDebugLifecycle } from "./debug-main.mjs";
import { setDebugLogSink } from "./debug-log.mjs";

function ipc() {
  const emitter = new EventEmitter();
  emitter.handlers = new Map();
  emitter.handle = (channel, handler) => emitter.handlers.set(channel, handler);
  emitter.removeHandler = channel => emitter.handlers.delete(channel);
  return emitter;
}

function logging(run) {
  const records = [];
  setDebugLogSink(record => records.push(record));
  return Promise.resolve().then(() => run(records)).finally(() => setDebugLogSink(null));
}

test("IPC preserves sync results, errors, async outcomes, receiver, and positional credential masks", () => logging(async records => {
  const main = ipc();
  installMainIpcDebug(main);
  installMainIpcDebug(main);
  const receiver = {};
  main.handle("product-account:confirm-email", function (_event, email, code, password) {
    assert.equal(this, receiver);
    assert.equal(code, "12345678");
    assert.equal(password, "actual-password");
    return { email };
  });
  assert.deepEqual(main.handlers.get("product-account:confirm-email").call(receiver, {}, "person@test", "12345678", "actual-password"), { email: "person@test" });
  assert.deepEqual(records[0].requestBody, ["person@test", "***", "***"]);
  assert.equal(records.length, 2);
  const failure = Object.assign(new Error("failed"), { code: "EHOSTUNREACH" });
  main.handle("fail", () => { throw failure; });
  assert.throws(() => main.handlers.get("fail")({}), error => error === failure);
  main.handle("async", async () => "done");
  assert.equal(await main.handlers.get("async")({}), "done");
  main.handle("reject", () => Promise.reject(failure));
  await assert.rejects(main.handlers.get("reject")({}), error => error === failure);
  assert.equal(records.at(-1).error.code, "EHOSTUNREACH");
  main.removeHandler("async");
  assert.equal(main.handlers.has("async"), false);
}));

test("EventEmitter registrations preserve order, once, removal, sync returnValue and duplicate listeners", () => logging(records => {
  const main = ipc();
  installMainIpcDebug(main);
  const calls = [];
  function listener(event) { assert.equal(this, main); calls.push("on"); event.returnValue = false; }
  main.on("sync", listener).on("sync", listener);
  assert.deepEqual(main.listeners("sync"), [listener, listener]);
  main.off("sync", listener);
  main.prependOnceListener("sync", () => calls.push("once"));
  const event = {};
  assert.equal(main.emit("sync", event), true);
  assert.equal(event.returnValue, false);
  assert.deepEqual(calls, ["once", "on"]);
  assert.equal(records.at(-1).responseBody, false);
  main.removeListener("sync", listener);
  assert.equal(main.listenerCount("sync"), 0);
  let count = 0;
  main.once("recursive", () => { count++; main.emit("recursive", {}); });
  main.emit("recursive", {});
  assert.equal(count, 1);
  main.once("removed", listener);
  main.removeListener("removed", listener);
  assert.equal(main.listenerCount("removed"), 0);
  main.addListener("clear", listener);
  main.removeAllListeners("clear");
  assert.equal(main.listenerCount("clear"), 0);
}));

test("disabled instrumentation never inspects arguments or changes sync behavior", () => {
  const main = ipc();
  installMainIpcDebug(main);
  const argument = { get token() { throw new Error("inspected"); } };
  main.handle("disabled", (_event, value) => value);
  assert.equal(main.handlers.get("disabled")({}, argument), argument);
  assert.equal(main.emit("absent", {}), false);
});

test("all webContents sends and utility messages and lifecycle use main sink without recursive transport records", () => logging(records => {
  const sent = [];
  const contents = { send(channel, ...args) { assert.equal(this, contents); sent.push([channel, ...args]); return 42; } };
  instrumentWebContentsDebug(contents);
  instrumentWebContentsDebug(contents);
  assert.equal(contents.send("account:changed", { balance: 7 }), 42);
  const proc = new EventEmitter();
  proc.pid = 123;
  proc.postMessage = function (...args) { assert.equal(this, proc); sent.push(args); return true; };
  instrumentUtilityProcessDebug(proc);
  assert.equal(proc.postMessage({ type: "hezuo:product-ai", token: "private" }), true);
  proc.emit("message", { type: "hezuo:renew-ai-token", requestId: "id" });
  proc.emit("spawn");
  utilityDebugLifecycle("ready", proc);
  utilityDebugLifecycle("restart", proc);
  proc.emit("exit", 1);
  const before = records.length;
  proc.emit("message", { type: "hezuo:debug-log", record: {} });
  proc.postMessage({ type: "hezuo:debug-log-enable" });
  contents.send("hezuo:debug-log", {});
  assert.equal(records.length, before);
  assert.equal(records.find(record => record.url === "hezuo:product-ai").requestBody.token, "***");
  for (const event of ["spawn", "ready", "restart", "exit"]) assert.ok(records.some(record => record.event === event));
}));

test("web contents creation and utility fork install observers before callers receive objects", () => logging(records => {
  const app = new EventEmitter(), main = ipc();
  const contents = { send() {} };
  const proc = new EventEmitter(); proc.postMessage = () => {}; proc.pid = 3;
  const utilityProcess = { fork: () => proc };
  installMainDebug({ app, ipcMain: main, webContents: { getAllWebContents: () => [contents] }, utilityProcess });
  contents.send("existing");
  const created = { send() {} };
  app.emit("web-contents-created", {}, created);
  created.send("created");
  assert.equal(utilityProcess.fork("server.mjs", []), proc);
  proc.postMessage({ type: "hezuo:drain" });
  for (const url of ["existing", "created", "hezuo:drain"]) assert.ok(records.some(record => record.url === url));
  assert.ok(records.some(record => record.event === "fork"));
}));

test("setter-only Electron sync replies retain the exact native reply receiver", () => logging(records => {
  const main = ipc();
  installMainIpcDebug(main);
  let sent;
  const channel = { sendReply(value) { assert.equal(this, channel); sent = value; } };
  const original = channel.sendReply;
  const event = { _replyChannel: channel };
  Object.defineProperty(event, "returnValue", { get() { return undefined; }, set(value) { event._replyChannel.sendReply(value); } });
  const descriptor = Object.getOwnPropertyDescriptor(event, "returnValue");
  main.on("native-sync", event => { event.returnValue = null; });
  main.emit("native-sync", event);
  assert.equal(sent, null);
  assert.equal(channel.sendReply, original);
  assert.equal(records.at(-1).responseBody, null);
  assert.deepEqual(Object.getOwnPropertyDescriptor(event, "returnValue"), descriptor);
  main.on("native-false", event => { event.returnValue = false; });
  main.emit("native-false", event);
  assert.equal(sent, false);
  assert.equal(records.at(-1).responseBody, false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(event, "returnValue"), descriptor);
}));
