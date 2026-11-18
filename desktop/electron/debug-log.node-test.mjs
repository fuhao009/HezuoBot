import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDebugLogWriter, debugError, debugLogEnabled, emitDebugLog, instrumentDebugFetch, isDebugSecretKey, sanitizeDebugLogRecord, setDebugLogSink } from "./debug-log.mjs";

async function eventually(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Expected debug record was not emitted");
}

test("logging is disabled by default and disabled fetch does not inspect inputs", async () => {
  assert.equal(debugLogEnabled(), false);
  emitDebugLog({ requestBody: { get password() { throw new Error("must not inspect"); } } });
  const response = new Response("unchanged");
  const input = { toString() { throw new Error("must not inspect"); } };
  const context = {};
  const fetch = instrumentDebugFetch(function (actual, init) {
    assert.equal(this, context);
    assert.equal(actual, input);
    assert.equal(init, undefined);
    return Promise.resolve(response);
  }, "test");
  assert.equal(await fetch.call(context, input), response);
});

test("central redaction handles nested objects, JSON strings, headers, URL and error causes", () => {
  const records = [];
  setDebugLogSink((record) => records.push(record));
  try {
    const inner = Object.assign(new Error("connect EHOSTUNREACH https://user:credential@host/api?access_token=url-secret&model=keep"), { code: "EHOSTUNREACH" });
    const error = new Error('request failed Authorization: Bearer bearer-secret', { cause: inner });
    emitDebugLog({
      layer: "test", error,
      requestBody: {
        password: "password-secret", refreshToken: "refresh-secret", api_key: "key-secret",
        nested: [{ authorization: "auth-secret", cookie: "cookie-secret", key: "plain-key-secret" }],
        serialized: JSON.stringify({ deeper: JSON.stringify({ token: "serialized-secret", content: "conversation" }) }),
        headers: new Headers({ authorization: "header-secret", "content-type": "application/json" }),
        email: "person@example.com", balance: 123, content: "ordinary conversation",
      },
    });
    assert.equal(records.length, 1);
    const text = JSON.stringify(records);
    for (const secret of ["credential", "url-secret", "bearer-secret", "password-secret", "refresh-secret", "key-secret", "auth-secret", "cookie-secret", "plain-key-secret", "serialized-secret", "header-secret"]) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.ok(text.includes("EHOSTUNREACH"));
    assert.ok(text.includes("conversation"));
    assert.ok(text.includes("person@example.com"));
    assert.equal(records[0].requestBody.balance, 123);
    assert.equal(records[0].error.cause.code, "EHOSTUNREACH");
    assert.ok(records[0].timestamp);
    const cyclic = new Error("outer");
    cyclic.cause = cyclic;
    assert.equal(debugError(cyclic).cause, "[Circular]");
  } finally { setDebugLogSink(null); }
});

test("writer rotates by UTF-8 bytes, retains every file, and resumes highest existing index", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hezuo-debug-"));
  try {
    const record = { responseBody: "中文 conversation" };
    const line = `${JSON.stringify({ ...record, timestamp: "2026-01-01T00:00:00.000Z" })}\n`;
    const maxBytes = Buffer.byteLength(line);
    const writer = createDebugLogWriter({ directory, maxBytes });
    writer(record);
    writer(record);
    assert.equal(JSON.parse(readFileSync(path.join(directory, "debug.log"), "utf8")).responseBody, record.responseBody);
    assert.equal(JSON.parse(readFileSync(path.join(directory, "debug-1.log"), "utf8")).responseBody, record.responseBody);
    const restarted = createDebugLogWriter({ directory, maxBytes });
    restarted(record);
    assert.equal(JSON.parse(readFileSync(path.join(directory, "debug-2.log"), "utf8")).responseBody, record.responseBody);
    writeFileSync(path.join(directory, "debug-12.log"), line);
    createDebugLogWriter({ directory, maxBytes })(record);
    assert.equal(JSON.parse(readFileSync(path.join(directory, "debug-13.log"), "utf8")).responseBody, record.responseBody);
    assert.equal(readdirSync(directory).length, 5);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("writer defaults to ten MiB and independently redacts records", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hezuo-debug-"));
  try {
    const writer = createDebugLogWriter({ directory });
    writer({ responseBody: "x".repeat(6 * 1024 * 1024), token: "never-write-me" });
    writer({ responseBody: "x".repeat(5 * 1024 * 1024) });
    assert.deepEqual(readdirSync(directory).sort(), ["debug-1.log", "debug.log"]);
    assert.ok(!readFileSync(path.join(directory, "debug.log"), "utf8").includes("never-write-me"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("writer uses receive order timestamps and preserves original event timestamps", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hezuo-debug-"));
  try {
    const writer = createDebugLogWriter({ directory });
    writer({ timestamp: "2099-01-01T00:00:00.000Z", event: "first" });
    writer({ timestamp: "2000-01-01T00:00:00.000Z", event: "second" });
    const records = readFileSync(path.join(directory, "debug.log"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(records[0].timestamp <= records[1].timestamp);
    assert.equal(records[0].eventTimestamp, "2099-01-01T00:00:00.000Z");
    assert.equal(records[1].eventTimestamp, "2000-01-01T00:00:00.000Z");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("multipart fields and serialized SSE payloads are centrally redacted", () => {
  const records = [];
  setDebugLogSink((record) => records.push(record));
  try {
    emitDebugLog({ requestBody: '--boundary\r\nContent-Disposition: form-data; name="password"\r\n\r\nmultipart-secret\r\n--boundary\r\nContent-Disposition: form-data; name="content"\r\n\r\nkeep this\r\n--boundary--\r\n' });
    emitDebugLog({ responseBody: 'data: {"token":{"nested":"nested-secret"},"content":"keep"}\n\n' });
    const text = JSON.stringify(records);
    assert.ok(!text.includes("multipart-secret"));
    assert.ok(!text.includes("nested-secret"));
    assert.ok(text.includes("keep this"));
  } finally { setDebugLogSink(null); }
});

test("credential recognition preserves token usage, identifiers and pricing in every representation", () => {
  const ordinary = { input_tokens: 101, output_tokens: 102, cached_input_tokens: 103, max_output_tokens: 104,
    tokenId: "token-identifier", monkey: "ordinary-monkey", input_token_price: 0.25, output_token_price: 0.5,
    cache_key: "cache-identifier", usage: { total_tokens: 306 }, pricing: { per_token: 0.125 } };
  const credentials = Object.fromEntries(["token", "access_token", "refreshToken", "id_token", "sessionToken", "account_token",
    "modelToken", "apiToken", "api_key", "apiKey", "x-api-key", "password", "passwd", "passphrase", "clientSecret",
    "private_key", "credentials", "Authorization", "Proxy-Authorization", "Cookie", "Set-Cookie"]
    .map((key, index) => [key, `sensitive-value-${index}-end`]));
  const fields = { ...ordinary, ...credentials };
  const records = [];
  setDebugLogSink(record => records.push(record));
  try {
    emitDebugLog({ nested: [{ ...fields }], serialized: JSON.stringify({ fields, encoded: JSON.stringify(fields) }),
      sse: `event: result\ndata: ${JSON.stringify(fields)}\n\n`,
      url: `https://example.test/api?${new URLSearchParams(Object.entries(fields).filter(([, value]) => typeof value !== "object"))}`,
      headers: new Headers(Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value !== "object").map(([key, value]) => [key, String(value)]))),
      multipart: Object.entries(fields).filter(([, value]) => typeof value !== "object").map(([key, value]) =>
        `--boundary\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join("") + "--boundary--\r\n",
      assignment: Object.entries(fields).filter(([, value]) => typeof value !== "object").map(([key, value]) => `${key}='${value}'`).join(" "),
      error: Object.assign(new Error(Object.entries(fields).filter(([, value]) => typeof value !== "object").map(([key, value]) => `${key}=${value}`).join(" ")), fields),
    });
    const record = records[0];
    assert.deepEqual(record.nested[0], { ...ordinary, ...Object.fromEntries(Object.keys(credentials).map(key => [key, "***"])) });
    const serialized = JSON.parse(record.serialized);
    assert.deepEqual(serialized.fields, record.nested[0]);
    assert.deepEqual(JSON.parse(serialized.encoded), record.nested[0]);
    assert.deepEqual(JSON.parse(record.sse.split("data: ")[1]), record.nested[0]);
    const url = new URL(record.url);
    for (const [key, value] of Object.entries(ordinary)) {
      assert.deepEqual(record.error[key], value, key);
      if (typeof value === "object") continue;
      assert.equal(url.searchParams.get(key), String(value), key);
      assert.equal(record.headers[key.toLowerCase()], String(value), key);
      assert.ok(record.multipart.includes(`name="${key}"\r\n\r\n${value}\r\n`), key);
      assert.ok(record.assignment.includes(`${key}='${value}'`), key);
      assert.ok(record.error.message.includes(`${key}=${value}`), key);
    }
    const text = JSON.stringify(record);
    for (const secret of Object.values(credentials)) assert.ok(!text.includes(secret), secret);
  } finally { setDebugLogSink(null); }
});

test("embedded JSON, escaped credentials, URL keys and private keys retain adjacent nonsecrets", () => {
  const records = [];
  setDebugLogSink(record => records.push(record));
  try {
    emitDebugLog({ message: 'failure {"nested":{"access_token":"embedded-private","tokenId":"keep-id","monkey":"keep-monkey"}}',
      escaped: '{"api\\u005fkey":"escaped-private","input_tokens":17}',
      url: "https://user:private-userinfo@host/?access%5Ftoken=encoded-private&tokenId=keep-id&monkey=keep-monkey",
      error: new Error('refreshToken="quoted private value" input_tokens=17 monkey=keep-monkey'),
      pem: "before -----BEGIN PRIVATE KEY-----\nprivate-pem\n-----END PRIVATE KEY----- after" });
    emitDebugLog({ pem: "-----BEGIN ENCRYPTED PRIVATE KEY-----\nencrypted-pem\n-----END ENCRYPTED PRIVATE KEY-----" });
    const text = JSON.stringify(records);
    for (const secret of ["embedded-private", "escaped-private", "encoded-private", "private-userinfo", "quoted private value", "private-pem", "encrypted-pem"]) assert.ok(!text.includes(secret), secret);
    for (const keep of ["keep-id", "keep-monkey", "input_tokens=17", "before", "after"]) assert.ok(text.includes(keep), keep);
  } finally { setDebugLogSink(null); }
});

test("long underscore identifiers in SSE and request history do not backtrack", { timeout: 5000 }, () => {
  // Synthetic shape only: a ~110 KB request repeated beside an SSE chunk with
  // a long opaque identifier containing the separators that defeated SECRET_KEY.
  const identifier = Array.from({ length: 29 }, (_, index) => "a".repeat(30) + (index < 23 ? "-" : "") + "b".repeat(20)).join("_");
  const requestBody = JSON.stringify({ messages: Array.from({ length: 250 }, () => ({ role: "user", content: "ordinary diagnostic text ".repeat(16) })) });
  const responseBody = `data: ${JSON.stringify({ id: identifier, content: "keep", usage: { input_tokens: 101, output_tokens: 17 } })}\n\n`;
  const safe = sanitizeDebugLogRecord({ requestBody, responseBody, assignments: `${identifier}: ordinary token=private-token input_tokens=101` });
  assert.equal(safe.requestBody, requestBody);
  assert.equal(safe.responseBody, responseBody);
  assert.ok(safe.assignments.includes(identifier));
  assert.ok(!safe.assignments.includes("private-token"));
  assert.ok(safe.assignments.includes("input_tokens=101"));
  assert.equal(isDebugSecretKey(identifier), false);
  assert.equal(isDebugSecretKey(`${identifier}_api_key`), true);
  assert.equal(isDebugSecretKey(`${identifier}_tokenId`), false);
});

test("scanning nested escaped JSON, embedded structured secrets and incomplete literals preserves diagnostics", () => {
  const fields = { credentials: [{ password: "nested-private" }], input_tokens: 17, content: "keep" };
  const nested = JSON.stringify({ encoded: JSON.stringify({ encoded: JSON.stringify(fields) }) });
  const safe = sanitizeDebugLogRecord({ nested, message: `failure ${JSON.stringify(fields)}`, partial: 'data: {"api_key":"unfinished-private' });
  assert.equal(JSON.parse(JSON.parse(JSON.parse(safe.nested).encoded).encoded).credentials, "***");
  assert.ok(safe.nested.includes("input_tokens"));
  assert.ok(!JSON.stringify(safe).includes("nested-private"));
  assert.ok(!JSON.stringify(safe).includes("unfinished-private"));
  assert.ok(safe.message.includes('"input_tokens":17'));
});

test("long ordinary tokens, incomplete quotes and repeated PEM starts remain bounded", { timeout: 5000 }, () => {
  const ordinary = "ordinary_identifier_".repeat(10000);
  const safe = sanitizeDebugLogRecord({ content: ordinary, quote: '"' + ordinary,
    pem: "keep " + "-----BEGIN PRIVATE KEY-----".repeat(1000) + "private-material" });
  assert.equal(safe.content, ordinary);
  assert.equal(safe.quote, '"' + ordinary);
  assert.equal(safe.pem, "keep ***");
  for (const key of ["input_tokens", "output_tokens", "tokenId", "cache_key", "monkey", "foo..password", "-password"]) assert.equal(isDebugSecretKey(key), false, key);
  for (const key of ["x-api-key", "provider_access_token", "foo.bar.clientSecret", "__password"]) assert.equal(isDebugSecretKey(key), true, key);
});

test("trusted private sink bypass is explicit and resets to default redaction", () => {
  const records = [];
  try {
    setDebugLogSink(record => records.push(record), { redact: false });
    emitDebugLog({ token: "worker-only-private" });
    assert.equal(records[0].token, "worker-only-private");
    assert.equal(sanitizeDebugLogRecord(records[0]).token, "***");
    setDebugLogSink(record => records.push(record));
    emitDebugLog({ token: "worker-only-private" });
    assert.equal(records[1].token, "***");
  } finally { setDebugLogSink(null); }
});

test("trusted sanitized writer preserves main receive timestamps without sanitizing twice", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hezuo-debug-"));
  try {
    const writer = createDebugLogWriter({ directory, sanitized: true, preserveTimestamp: true });
    const record = { timestamp: "2026-01-01T00:00:01.000Z", eventTimestamp: "2026-01-01T00:00:00.000Z", content: "already safe" };
    writer(record);
    assert.deepEqual(JSON.parse(readFileSync(path.join(directory, "debug.log"), "utf8")), record);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("fetch logs success without changing Response identity or ordinary bodies", async () => {
  const records = [];
  setDebugLogSink((record) => records.push(record));
  try {
    const text = '{ "content": "hello", "balance": 12 }';
    const response = new Response(text, { status: 201, headers: { "x-ai-request-id": "req-1" } });
    const init = { method: "POST", body: '{ "content": "question" }' };
    const fetch = instrumentDebugFetch(async (input, options) => {
      assert.equal(input, "https://example.test/api");
      assert.equal(options, init);
      return response;
    }, "gateway");
    const actual = await fetch("https://example.test/api", init);
    assert.equal(actual, response);
    assert.equal(await actual.text(), text);
    await eventually(() => records.some((record) => record.event === "response"));
    const result = records.find((record) => record.event === "response");
    assert.equal(result.status, 201);
    assert.equal(result.requestId, "req-1");
    assert.equal(result.responseBody, text);
    assert.equal(result.requestBody, init.body);
    assert.ok(result.durationMs >= 0);
    assert.equal(result.layer, "gateway");
  } finally { setDebugLogSink(null); }
});

test("fetch failures preserve error identity and lower-level causes; throwing sinks are harmless", async () => {
  const records = [];
  setDebugLogSink((record) => records.push(record));
  try {
    const cause = Object.assign(new Error("certificate rejected"), { code: "CERT_HAS_EXPIRED" });
    const failure = new TypeError("fetch failed", { cause });
    const fetch = instrumentDebugFetch(async () => { throw failure; }, "gateway");
    await assert.rejects(fetch("https://example.test"), (error) => error === failure);
    await eventually(() => records.some((record) => record.event === "error"));
    assert.equal(records.find((record) => record.event === "error").error.cause.code, "CERT_HAS_EXPIRED");
    let responseLogged = false;
    setDebugLogSink((record) => {
      if (record.event === "response") responseLogged = true;
      throw new Error("disk unavailable");
    });
    const response = new Response("ok");
    assert.equal(await instrumentDebugFetch(async () => response, "gateway")("https://example.test"), response);
    await eventually(() => responseLogged);
  } finally { setDebugLogSink(null); }
});

test("SSE logs complete frames live in order and redacts secrets split across transport chunks", async () => {
  const records = [];
  let controller;
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } });
  setDebugLogSink((record) => records.push(record));
  try {
    const actual = await instrumentDebugFetch(async () => response, "model")("https://example.test/chat");
    const consumed = actual.text();
    controller.enqueue(encoder.encode('data: {"content":"first","api_'));
    controller.enqueue(encoder.encode('key":"split-'));
    controller.enqueue(encoder.encode('secret"}\n\n'));
    await eventually(() => records.some((record) => record.event === "chunk"));
    assert.equal(records.some((record) => record.event === "response"), false);
    assert.ok(!JSON.stringify(records).includes("split-secret"));
    controller.enqueue(encoder.encode('data: {"content":"second"}\n\n'));
    await eventually(() => records.filter((record) => record.event === "chunk").length === 2);
    controller.close();
    assert.equal(await consumed, 'data: {"content":"first","api_key":"split-secret"}\n\ndata: {"content":"second"}\n\n');
    await eventually(() => records.some((record) => record.event === "response"));
    const chunks = records.filter((record) => record.event === "chunk");
    assert.deepEqual(chunks.map((record) => record.chunkIndex), [0, 1]);
    assert.ok(chunks[0].responseBody.includes("first"));
    assert.ok(chunks[1].responseBody.includes("second"));
    assert.ok(chunks.every((record) => record.timestamp));
  } finally { setDebugLogSink(null); }
});

test("stream failures preserve already received frames and underlying error details", async () => {
  const records = [];
  let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } });
  setDebugLogSink((record) => records.push(record));
  try {
    const actual = await instrumentDebugFetch(async () => response, "model")("https://example.test/chat");
    const consumed = actual.text();
    controller.enqueue(new TextEncoder().encode('data: {"content":"before failure"}\n\n'));
    await eventually(() => records.some((record) => record.event === "chunk"));
    controller.error(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }));
    await assert.rejects(consumed, /socket reset/);
    await eventually(() => records.some((record) => record.event === "error"));
    assert.equal(records.find((record) => record.event === "error").error.code, "ECONNRESET");
  } finally { setDebugLogSink(null); }
});
