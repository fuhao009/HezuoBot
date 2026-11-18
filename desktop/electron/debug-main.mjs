import { debugLogEnabled, emitDebugLog, debugError } from "./debug-log.mjs";

const installed = new WeakSet();
const transports = new Set(["hezuo:debug-log", "hezuo:debug-log-enable"]);
const secretPositions = new Map([
  ["product-account:sign-in-password", [1]], ["product-account:sign-up", [1]],
  ["product-account:verify-code", [1]], ["product-account:confirm-email", [1, 2]],
  ["product-account:reset-password", [1, 2]], ["companion-account:verify-code", [1]],
  ["desktop-remote:pair", [1]], ["companion:pairing", [1]],
  ["credential:set", [1]], ["cloud-account:signInVerify", [0]],
]);

function ipcArguments(channel, args) {
  const positions = secretPositions.get(channel);
  if (!positions) return args;
  return args.map((value, index) => positions.includes(index) ? "***" : value);
}

function observeCall({ layer, method, url, requestBody }, invoke, resultBody = value => value) {
  const started = performance.now();
  const base = { layer, method, url, requestBody, requestId: null };
  emitDebugLog({ ...base, event: "request", status: null, durationMs: 0 });
  const success = value => {
    emitDebugLog({ ...base, event: "response", status: 200, durationMs: performance.now() - started, responseBody: resultBody(value) });
    return value;
  };
  const failure = error => {
    emitDebugLog({ ...base, event: "error", status: null, durationMs: performance.now() - started, error: debugError(error) });
    throw error;
  };
  let value;
  try { value = invoke(); } catch (error) { return failure(error); }
  return value && typeof value.then === "function" ? value.then(success, failure) : success(value);
}

/** Install before importing modules that register IPC at module evaluation time. */
export function installMainIpcDebug(ipcMain) {
  if (installed.has(ipcMain)) return;
  installed.add(ipcMain);
  const handle = ipcMain.handle;
  ipcMain.handle = function (channel, listener) {
    if (typeof listener !== "function") return handle.apply(this, arguments);
    return handle.call(this, channel, function (event, ...args) {
      if (!debugLogEnabled() || transports.has(channel)) return listener.call(this, event, ...args);
      return observeCall({ layer: "page->main", method: "IPC", url: channel, requestBody: ipcArguments(channel, args) },
        () => listener.call(this, event, ...args));
    });
  };
  const add = ipcMain.on;
  const prepend = ipcMain.prependListener;
  const remove = ipcMain.removeListener;
  function register(target, channel, listener, once, first) {
    if (typeof listener !== "function") return (first ? prepend : add).call(target, channel, listener);
    function wrapped(event, ...args) {
      if (once) remove.call(target, channel, wrapped);
      if (!debugLogEnabled() || transports.has(channel)) return listener.call(this, event, ...args);
      // Electron's non-configurable returnValue setter calls
      // event._replyChannel.sendReply(value), with the value itself (not an array).
      // Observe that writable native method without replacing the event/setter.
      const replyChannel = event?._replyChannel;
      const descriptor = replyChannel && Object.getOwnPropertyDescriptor(replyChannel, "sendReply");
      let replied = false, reply;
      const observeReply = Boolean(descriptor?.writable && typeof descriptor.value === "function");
      if (observeReply) replyChannel.sendReply = function (value) {
        const result = descriptor.value.apply(this, arguments);
        replied = true;
        reply = value;
        return result;
      };
      try {
        return observeCall({ layer: "page->main", method: "IPC", url: channel, requestBody: ipcArguments(channel, args) },
          () => listener.call(this, event, ...args), value => replied ? reply : event?.returnValue ?? value);
      } finally {
        if (observeReply) Object.defineProperty(replyChannel, "sendReply", descriptor);
      }
    }
    // EventEmitter uses this property for listeners(), removeListener() and remove events.
    wrapped.listener = listener;
    return (first ? prepend : add).call(target, channel, wrapped);
  }
  for (const [name, once, first] of [["on", false, false], ["addListener", false, false], ["once", true, false], ["prependListener", false, true], ["prependOnceListener", true, true]]) {
    ipcMain[name] = function (channel, listener) { return register(this, channel, listener, once, first); };
  }
}

export function instrumentWebContentsDebug(contents) {
  if (installed.has(contents)) return;
  installed.add(contents);
  const send = contents.send;
  contents.send = function (channel, ...args) {
    if (!debugLogEnabled() || transports.has(channel)) return send.apply(this, arguments);
    return observeCall({ layer: "main->page", method: "IPC", url: channel, requestBody: ipcArguments(channel, args) },
      () => send.call(this, channel, ...args));
  };
}

export function utilityDebugLifecycle(event, proc, details = {}) {
  if (!debugLogEnabled()) return;
  emitDebugLog({ layer: "main<->server", method: "UTILITY", url: "utility-process", event, status: null, durationMs: 0,
    requestId: null, responseBody: { pid: proc?.pid ?? null, ...details } });
}

export function instrumentUtilityProcessDebug(proc) {
  if (installed.has(proc)) return proc;
  installed.add(proc);
  const postMessage = proc.postMessage;
  proc.postMessage = function (message, ...rest) {
    if (!debugLogEnabled() || transports.has(message?.type)) return postMessage.call(this, message, ...rest);
    return observeCall({ layer: "main->server", method: "IPC", url: message?.type ?? "message", requestBody: message },
      () => postMessage.call(this, message, ...rest));
  };
  proc.on("message", message => {
    if (!debugLogEnabled() || transports.has(message?.type)) return;
    emitDebugLog({ layer: "server->main", method: "IPC", url: message?.type ?? "message", event: "message", status: null,
      durationMs: 0, requestId: message?.requestId ?? null, responseBody: message });
  });
  proc.on("spawn", () => utilityDebugLifecycle("spawn", proc));
  proc.on("exit", code => utilityDebugLifecycle("exit", proc, { code }));
  return proc;
}

export function installMainDebug({ app, ipcMain, webContents, utilityProcess }) {
  installMainIpcDebug(ipcMain);
  app.on("web-contents-created", (_event, contents) => instrumentWebContentsDebug(contents));
  for (const contents of webContents.getAllWebContents()) instrumentWebContentsDebug(contents);
  const fork = utilityProcess.fork;
  utilityProcess.fork = function (...args) {
    if (!debugLogEnabled()) return instrumentUtilityProcessDebug(fork.apply(this, args));
    return observeCall({ layer: "main<->server", method: "UTILITY", url: "utility-process", requestBody: { entry: args[0], args: args[1] } }, () => {
      const proc = instrumentUtilityProcessDebug(fork.apply(this, args));
      utilityDebugLifecycle("fork", proc, { entry: args[0] });
      return proc;
    }, proc => ({ pid: proc.pid ?? null }));
  };
}
