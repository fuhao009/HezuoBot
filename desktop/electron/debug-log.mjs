import { appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

let sink = null;
let redactSink = true;
// Match credential names, not arbitrary occurrences of "token" or a "key" suffix.
// Token counters/limits and identifiers (including tokenId) are diagnostic data.
const SECRET_NAME = /^(?:password|passwd|passphrase|secret|credentials?|api[-_.]?key|private[-_.]?key|secret[-_.]?key|signing[-_.]?key|encryption[-_.]?key|client[-_.]?secret|(?:access|refresh|id|session|account|model|api|auth|authentication|bearer|security|csrf|xsrf)[-_.]?token)$/i;
const EXACT_SECRET_NAME = /^(?:token|key|authorization|proxy[-_.]?authorization|cookie|set[-_.]?cookie)$/i;

function redactAssignments(value) {
  let result = "";
  let copiedThrough = 0;
  let index = 0;
  while (index < value.length) {
    const boundary = index === 0 || !/[\w.-]/.test(value[index - 1]);
    if (boundary && /[\w.-]/.test(value[index])) {
      const keyStart = index;
      while (index < value.length && /[\w.-]/.test(value[index])) index += 1;
      const key = value.slice(keyStart, index);
      const separatorStart = index;
      while (index < value.length && /\s/.test(value[index])) index += 1;
      if ((value[index] === "=" || value[index] === ":") && isDebugSecretKey(key)) {
        index += 1;
        while (index < value.length && /\s/.test(value[index])) index += 1;
        const quote = value[index] === '"' || value[index] === "'" ? value[index] : "";
        const valueStart = index;
        if (quote) {
          index += 1;
          while (index < value.length) {
            if (value[index] === "\\") index += 2;
            else if (value[index++] === quote) break;
          }
        } else while (index < value.length && !/[\s&,;]/.test(value[index])) index += 1;
        if (index > valueStart) {
          result += value.slice(copiedThrough, valueStart) + `${quote}***${quote}`;
          copiedThrough = index;
        }
        continue;
      }
      index = separatorStart;
    }
    index += 1;
  }
  return result + value.slice(copiedThrough);
}

function redactJsonSecrets(value) {
  let result = "", copiedThrough = 0, index = 0;
  while (index < value.length) {
    if (value[index] !== '"') { index += 1; continue; }
    const keyStart = index;
    index += 1;
    while (index < value.length) { if (value[index] === "\\") index += 2; else if (value[index++] === '"') break; }
    if (value[index - 1] !== '"') break;
    let cursor = index;
    while (/\s/.test(value[cursor] ?? "")) cursor += 1;
    if (value[cursor] !== ":") continue;
    let key; try { key = JSON.parse(value.slice(keyStart, index)); } catch { continue; }
    if (!isDebugSecretKey(key)) continue;
    cursor += 1; while (/\s/.test(value[cursor] ?? "")) cursor += 1;
    const valueStart = cursor;
    if (value[cursor] === '"') { cursor += 1; while (cursor < value.length) { if (value[cursor] === "\\") cursor += 2; else if (value[cursor++] === '"') break; } }
    else if (value[cursor] === "{" || value[cursor] === "[") {
      let depth = 0;
      do {
        const character = value[cursor++];
        if (character === '"') {
          while (cursor < value.length) { if (value[cursor] === "\\") cursor += 2; else if (value[cursor++] === '"') break; }
        } else if (character === "{" || character === "[") depth += 1;
        else if (character === "}" || character === "]") depth -= 1;
      } while (cursor < value.length && depth > 0);
    } else { while (cursor < value.length && !/[,}\]\r\n]/.test(value[cursor])) cursor += 1; while (cursor > valueStart && /\s/.test(value[cursor - 1])) cursor -= 1; }
    if (cursor > valueStart) { result += value.slice(copiedThrough, valueStart) + '"***"'; copiedThrough = cursor; }
    index = cursor;
  }
  return result ? result + value.slice(copiedThrough) : value;
}

export function isDebugSecretKey(name) {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  if (EXACT_SECRET_NAME.test(normalized)) return true;
  // Only a fixed-size credential suffix can match. Prefix separators between
  // word groups are unambiguous here, unlike the old nested underscore regex.
  for (let index = Math.max(0, normalized.length - 32); index < normalized.length; index += 1) {
    if (index > 0 && !/[-_.]/.test(normalized[index - 1])) continue;
    if (SECRET_NAME.test(normalized.slice(index)) && (index === 0 || /^\w+(?:[-.]\w+)*[-_.]$/.test(normalized.slice(0, index)))) return true;
  }
  return false;
}

export function setDebugLogSink(value, { redact = true } = {}) {
  sink = typeof value === "function" ? value : null;
  redactSink = redact;
}

export function debugLogEnabled() {
  return sink !== null;
}

function redactText(value) {
  // Consume complete quoted tokens, never retrying a failed match at each
  // character. Decoding removes at least one escaping layer on each descent.
  let output = "", copiedThrough = 0, index = 0;
  while (index < value.length) {
    if (value[index] !== '"') { index += 1; continue; }
    const start = index++;
    while (index < value.length) {
      if (value[index] === "\\") index += 2;
      else if (value[index++] === '"') break;
    }
    const literal = value.slice(start, index);
    if (!literal.includes("\\")) continue;
    try {
      const decoded = JSON.parse(literal);
      const safe = redactText(decoded);
      if (safe !== decoded) { output += value.slice(copiedThrough, start) + JSON.stringify(safe); copiedThrough = index; }
    } catch { /* Preserve malformed or incomplete literals. */ }
  }
  if (copiedThrough) value = output + value.slice(copiedThrough);
  value = redactMultipart(value);
  value = redactJsonSecrets(value);
  return redactAssignments(redactPrivateKeys(value)
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => url
      .replace(/(https?:\/\/)[^/@\s]+@/i, "$1***@")
      .replace(/([?&#])([^=&#]+)=([^&#]*)/g, (all, delimiter, key) => {
        let decoded = key;
        try { decoded = decodeURIComponent(key); } catch { /* Preserve malformed URL keys. */ }
        return isDebugSecretKey(decoded) ? `${delimiter}${key}=***` : all;
      }))
    .replace(/^([ \t]*(?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*:[ \t]*).*$/gmi, "$1***")
    .replace(/\b(Bearer|Basic)\s+[^\s,"'\\]+/gi, "$1 ***")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "***"));
}

function redactPrivateKeys(value) {
  const begin = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g;
  const end = /-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g;
  let result = "", copiedThrough = 0, match;
  while ((match = begin.exec(value))) {
    end.lastIndex = begin.lastIndex;
    const closing = end.exec(value);
    const through = closing ? end.lastIndex : value.length;
    result += value.slice(copiedThrough, match.index) + "***";
    copiedThrough = through;
    begin.lastIndex = through;
    if (!closing) break;
  }
  return copiedThrough ? result + value.slice(copiedThrough) : value;
}

function redactMultipart(value) {
  if (!/Content-Disposition:/i.test(value)) return value;
  const lines = value.split(/(?<=\n)/);
  let secret = false, body = false, replaced = false;
  return lines.map((line) => {
    if (line.startsWith("--")) { secret = false; body = false; replaced = false; return line; }
    if (!body) {
      const disposition = /^Content-Disposition:[^\r\n]*?\bname="([^"]+)"/i.exec(line);
      if (disposition) secret = isDebugSecretKey(disposition[1]);
      if (/^\r?\n$/.test(line)) body = true;
      return line;
    }
    if (!secret) return line;
    const result = replaced ? "" : "***";
    replaced = true;
    return result + (/\r?\n$/.exec(line)?.[0] ?? "");
  }).join("");
}

function redact(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return typeof value === "bigint" ? String(value) : value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  let result;
  if (value instanceof Error) {
    result = {};
    for (const key of new Set(["name", "message", "stack", "cause", ...Object.getOwnPropertyNames(value)])) {
      if (value[key] !== undefined) result[key] = isDebugSecretKey(key) ? "***" : redact(value[key], seen);
    }
  } else if (value instanceof Headers) {
    result = {};
    for (const [key, item] of value) result[key] = isDebugSecretKey(key) ? "***" : redact(item, seen);
  } else if (Array.isArray(value)) {
    result = value.map((item) => redact(item, seen));
  } else {
    result = {};
    for (const [key, item] of Object.entries(value)) result[key] = isDebugSecretKey(key) ? "***" : redact(item, seen);
  }
  seen.delete(value);
  return result;
}

/** Sanitize once at the process boundary that owns private log persistence. */
export function sanitizeDebugLogRecord(record) {
  return redact(record);
}

export function debugError(error) {
  return redact(error instanceof Error ? error : { message: String(error) });
}

export function emitDebugLog(record) {
  if (!sink) return;
  try {
    const entry = { timestamp: new Date().toISOString(), ...record };
    sink(redactSink ? sanitizeDebugLogRecord(entry) : entry);
  } catch { /* Diagnostics must never change application behavior. */ }
}

/** The main process is the only writer. Existing numbered files are never reused. */
export function createDebugLogWriter({ directory, maxBytes = 10 * 1024 * 1024, sanitized = false, preserveTimestamp = false }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("Invalid debug log size");
  mkdirSync(directory, { recursive: true });
  let index = 0;
  for (const name of readdirSync(directory)) {
    const match = /^debug-(\d+)\.log$/.exec(name);
    if (match) index = Math.max(index, Number(match[1]));
  }
  const filename = () => path.join(directory, index ? `debug-${index}.log` : "debug.log");
  let size;
  try { size = statSync(filename()).size; } catch (error) {
    if (error.code !== "ENOENT") throw error;
    size = 0;
  }
  let lastTimestamp = 0;
  return (record) => {
    lastTimestamp = Math.max(lastTimestamp, Date.now());
    const entry = preserveTimestamp && record.timestamp ? record : { ...record, ...(record.timestamp ? { eventTimestamp: record.eventTimestamp ?? record.timestamp } : {}), timestamp: new Date(lastTimestamp).toISOString() };
    const line = `${JSON.stringify(sanitized ? entry : sanitizeDebugLogRecord(entry))}\n`;
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) {
      index += 1;
      size = 0;
    }
    appendFileSync(filename(), line, { encoding: "utf8", mode: 0o600 });
    size += bytes;
  };
}

async function requestBody(input, init) {
  if (init?.body != null) {
    const body = init.body;
    if (typeof body === "string" || body instanceof URLSearchParams) return String(body);
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    if (body instanceof Blob) return body.text();
    if (body instanceof FormData) return [...body].map(([key, value]) => ({ [key]: typeof value === "string" ? value : { name: value.name, size: value.size, type: value.type } }));
    // Unsupported caller-owned streams remain untouched; never claim their
    // content was captured or consume them ahead of the transport.
    return undefined;
  }
  if (input instanceof Request && input.body) return input.clone().text();
  return undefined;
}

async function observeResponse(response, base, body, started) {
  const common = { ...base, status: response.status, requestId: response.headers.get("x-ai-request-id") || undefined };
  const request = await body;
  const clone = response;
  const streaming = /(?:text\/event-stream|(?:x-)?ndjson)/i.test(response.headers.get("content-type") || "");
  if (!streaming || !clone.body) {
    try {
      emitDebugLog({ ...common, event: "response", durationMs: Date.now() - started, requestBody: request, responseBody: await clone.text() });
    } catch (error) {
      emitDebugLog({ ...common, event: "error", durationMs: Date.now() - started, requestBody: request, error: debugError(error) });
    }
    return;
  }
  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  const sse = /text\/event-stream/i.test(response.headers.get("content-type") || "");
  let pending = "";
  let sequence = 0;
  const emitFrame = (frame) => emitDebugLog({
    ...common, event: "chunk", chunkIndex: sequence++, timestamp: new Date().toISOString(),
    durationMs: Date.now() - started, responseBody: redactText(frame),
  });
  let failure;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      // Field names and values can straddle transport chunks. Only complete
      // protocol frames are safe to redact, but emit those without waiting
      // for the entire response (important for crash diagnostics).
      let boundary;
      while ((boundary = (sse ? /\r?\n\r?\n/ : /\r?\n/).exec(pending))) {
        const end = boundary.index + boundary[0].length;
        emitFrame(pending.slice(0, end));
        pending = pending.slice(end);
      }
    }
    pending += decoder.decode();
  } catch (error) { failure = error; }
  if (pending) emitFrame(pending);
  emitDebugLog({ ...common, event: failure ? "error" : "response", durationMs: Date.now() - started, requestBody: request, ...(failure ? { error: debugError(failure) } : {}) });
}

export function instrumentDebugFetch(fetchImpl, layer) {
  return async function (input, init) {
    if (!debugLogEnabled()) return Reflect.apply(fetchImpl, this, arguments);
    const started = Date.now();
    const base = { layer, method: init?.method || (input instanceof Request ? input.method : "GET"), url: input instanceof Request ? input.url : String(input) };
    const body = requestBody(input, init).catch((error) => ({ error: debugError(error) }));
    void body.then((request) => emitDebugLog({ ...base, event: "request", requestBody: request }));
    try {
      const response = await Reflect.apply(fetchImpl, this, arguments);
      // Preserve Response identity, headers, redirects and cancellation semantics.
      // A tee can queue data if the caller is slow; observing it must never
      // replace the caller's live stream or make a successful fetch reject.
      try {
        const observed = response.clone();
        void observeResponse(observed, base, body, started).catch((error) => {
          emitDebugLog({ ...base, event: "error", durationMs: Date.now() - started, error: debugError(error) });
        });
      } catch (error) {
        emitDebugLog({ ...base, event: "error", durationMs: Date.now() - started, error: debugError(error) });
      }
      return response;
    } catch (error) {
      void body.then((request) => emitDebugLog({ ...base, event: "error", durationMs: Date.now() - started, requestBody: request, error: debugError(error) }));
      throw error;
    }
  };
}
