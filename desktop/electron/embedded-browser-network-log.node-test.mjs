import assert from "node:assert/strict";
import test from "node:test";
import { installEmbeddedBrowserNetworkLogger } from "./embedded-browser-network-log.mjs";
import { setDebugLogSink } from "./debug-log.mjs";

function fixture() {
  const listeners = {};
  const registrations = [];
  const webRequest = Object.fromEntries(["onBeforeRequest", "onResponseStarted", "onBeforeRedirect", "onCompleted", "onErrorOccurred"].map(name => [name, listener => {
    registrations.push(name);
    listeners[name] = listener;
  }]));
  return { session: { webRequest }, listeners, registrations };
}
const details = (id, url = "https://example.test/page") => ({ id, url, method: "GET", resourceType: "xhr", webContentsId: 7 });

test("disabled diagnostics installs only the security listener", () => {
  setDebugLogSink(null);
  const { session, listeners, registrations } = fixture();
  const logger = installEmbeddedBrowserNetworkLogger(session, { shouldCancel: url => url.endsWith("/blocked") });
  assert.deepEqual(registrations, ["onBeforeRequest"]);
  let result;
  listeners.onBeforeRequest(details(1, "https://example.test/blocked"), value => { result = value; });
  assert.deepEqual(result, { cancel: true });
  logger.dispose();
  assert.deepEqual(registrations, ["onBeforeRequest"]);
});

test("redirects, responses, failures and disposal retain metadata and release inflight state", () => {
  const records = [];
  setDebugLogSink(record => records.push(record));
  try {
    const { session, listeners, registrations } = fixture();
    const logger = installEmbeddedBrowserNetworkLogger(session, { shouldCancel: url => url.endsWith("/blocked") });
    assert.equal(registrations.filter(name => name === "onBeforeRequest").length, 1);
    const request = (id, url) => {
      let result;
      listeners.onBeforeRequest(details(id, url), value => { result = value; });
      return result;
    };
    request(1);
    listeners.onBeforeRedirect({ ...details(1), statusCode: 302, redirectURL: "https://example.test/final" });
    request(1, "https://example.test/final");
    listeners.onResponseStarted({ ...details(1, "https://example.test/final"), statusCode: 201 });
    listeners.onCompleted({ ...details(1, "https://example.test/final"), statusCode: 201 });
    assert.deepEqual(request(2, "https://example.test/blocked"), { cancel: true });
    listeners.onErrorOccurred({ ...details(2, "https://example.test/blocked"), error: "net::ERR_BLOCKED_BY_CLIENT" });
    request(3);
    const lateError = listeners.onErrorOccurred;
    logger.dispose();
    logger.dispose();
    lateError({ ...details(3), error: "net::ERR_ABORTED" });
    const terminal = records.filter(record => record.event !== "request");
    assert.deepEqual(terminal.map(record => record.event), ["redirect", "response", "error", "error"]);
    assert.equal(terminal[0].requestId, terminal[1].requestId);
    assert.equal(terminal[0].status, 302);
    assert.equal(terminal[0].redirectURL, "https://example.test/final");
    assert.equal(terminal[1].status, 201);
    assert.equal(terminal[2].error.message, "net::ERR_BLOCKED_BY_CLIENT");
    assert.equal(terminal[3].error.code, "ERR_ABORTED");
    assert.equal(listeners.onCompleted, null);
    assert.equal(listeners.onErrorOccurred, null);
    let blocked;
    listeners.onBeforeRequest(details(4, "https://example.test/blocked"), value => { blocked = value.cancel; });
    assert.equal(blocked, true);
    for (const record of records) {
      assert(record.durationMs >= 0);
      assert(!("requestBody" in record));
      assert(!("responseBody" in record));
    }
  } finally {
    setDebugLogSink(null);
  }
});
