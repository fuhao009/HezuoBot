import { randomUUID } from "node:crypto";
import { debugLogEnabled, emitDebugLog } from "./debug-log.mjs";

/** Owns the session's single Electron webRequest listener per event, including its security gate. */
export function installEmbeddedBrowserNetworkLogger(session, { shouldCancel }) {
  const webRequest = session.webRequest;
  const enabled = debugLogEnabled();
  const inflight = enabled ? new Map() : null;
  const sessionId = enabled ? randomUUID() : null;
  let disposed = false;
  const guard = (details, callback) => callback({ cancel: shouldCancel(details.url) });
  if (!enabled) {
    webRequest.onBeforeRequest(guard);
    return { dispose() {} };
  }
  const record = (details, state, event, extra = {}) => {
    emitDebugLog({ layer: "embedded-browser->network", event, url: details.url, method: details.method,
      requestId: `${sessionId}:${details.id}`, resourceType: details.resourceType,
      webContentsId: details.webContentsId ?? null, status: details.statusCode ?? state.status ?? null,
      durationMs: performance.now() - state.started, ...extra });
  };
  webRequest.onBeforeRequest((details, callback) => {
    if (!disposed && debugLogEnabled()) {
      const state = { started: performance.now(), details, status: null };
      inflight.set(details.id, state);
      record(details, state, "request");
    }
    guard(details, callback);
  });
  webRequest.onResponseStarted(details => {
    const state = inflight.get(details.id);
    if (state) state.status = details.statusCode;
  });
  webRequest.onBeforeRedirect(details => {
    const state = inflight.get(details.id);
    if (!state) return;
    inflight.delete(details.id);
    record(details, state, "redirect", { redirectURL: details.redirectURL });
  });
  webRequest.onCompleted(details => {
    const state = inflight.get(details.id);
    if (!state) return;
    inflight.delete(details.id);
    record(details, state, "response");
  });
  webRequest.onErrorOccurred(details => {
    const state = inflight.get(details.id);
    if (!state) return;
    inflight.delete(details.id);
    record(details, state, "error", { error: { message: details.error } });
  });
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      webRequest.onBeforeRequest(guard);
      webRequest.onResponseStarted(null);
      webRequest.onBeforeRedirect(null);
      webRequest.onCompleted(null);
      webRequest.onErrorOccurred(null);
      for (const state of inflight.values()) {
        record(state.details, state, "error", { error: { message: "Browser session disposed", code: "ERR_ABORTED" } });
      }
      inflight.clear();
    },
  };
}
