import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { StringDecoder } from "node:string_decoder";
import { debugError, debugLogEnabled, emitDebugLog } from "../electron/debug-log.mjs";

const fetchScope = new AsyncLocalStorage<boolean>();
let installed = false;
const observedFetch = new WeakSet<typeof fetch>();
const layer = "server->external";
type Fields = Record<string, unknown>;
interface BodyCapture {
  add(chunk: Uint8Array | string, encoding?: BufferEncoding): void;
  finish(error?: unknown, cancelled?: boolean): void;
}

function captureBody(fields: () => Fields, started: number, streaming: boolean): BodyCapture {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let chunkIndex = 0;
  let finished = false;
  const frame = (text: string) => emitDebugLog({ ...fields(), event: "chunk", chunkIndex: chunkIndex++, durationMs: Date.now() - started, responseBody: text });
  return {
    add(chunk: Uint8Array | string, encoding?: BufferEncoding) {
      if (finished) return;
      pending += typeof chunk === "string" ? decoder.write(Buffer.from(chunk, encoding)) : decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (!streaming) return;
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const end = boundary.index + boundary[0].length;
        frame(pending.slice(0, end));
        pending = pending.slice(end);
      }
    },
    finish(error?: unknown, cancelled = false) {
      if (finished) return;
      finished = true;
      pending += decoder.end();
      if (streaming && pending) frame(pending);
      emitDebugLog({ ...fields(), event: error ? "error" : cancelled ? "cancel" : "response", durationMs: Date.now() - started,
        ...(!streaming ? { responseBody: pending } : {}), ...(error ? { error: debugError(error) } : {}) });
    },
  };
}

function observeStream(stream: ReadableStream<Uint8Array>, capture: BodyCapture) {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) { capture.finish(); controller.close(); }
        else { capture.add(result.value); controller.enqueue(result.value); }
      } catch (error) { capture.finish(error); controller.error(error); }
    },
    cancel(reason) { capture.finish(undefined, true); return reader.cancel(reason); },
  }, { highWaterMark: 0 });
}

/** Instruments a non-global transport without duplicating the process fetch or Node transport. */
export function debugOutboundFetch(transport: typeof fetch): typeof fetch {
  if (observedFetch.has(transport)) return transport;
  const wrapped = async function (this: unknown, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    if (!debugLogEnabled() || fetchScope.getStore()) return Reflect.apply(transport, this, [input, init]);
    const started = Date.now();
    const base = { layer, method: init?.method ?? (input instanceof Request ? input.method : "GET"), url: input instanceof Request ? input.url : String(input) };
    let requestBody: unknown;
    let actualInput = input;
    let actualInit = init;
    const requestChunks: Buffer[] = [];
    const originalBody = init?.body ?? (input instanceof Request ? input.body : undefined);
    if (originalBody instanceof ReadableStream) {
      const reader = originalBody.getReader();
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) { requestBody = Buffer.concat(requestChunks).toString("utf8"); controller.close(); }
            else { requestChunks.push(Buffer.from(result.value)); controller.enqueue(result.value); }
          } catch (error) { controller.error(error); }
        },
        cancel(reason) { return reader.cancel(reason); },
      }, { highWaterMark: 0 });
      actualInit = { ...init, body, duplex: "half" } as RequestInit;
      if (input instanceof Request) actualInput = new Request(input.url, { method: input.method, headers: input.headers, signal: input.signal, credentials: input.credentials, cache: input.cache, redirect: input.redirect, referrer: input.referrer, referrerPolicy: input.referrerPolicy, integrity: input.integrity, mode: input.mode });
    } else if (originalBody != null) {
      if (typeof originalBody === "string" || originalBody instanceof URLSearchParams) requestBody = String(originalBody);
      else if (originalBody instanceof ArrayBuffer) requestBody = Buffer.from(originalBody).toString("utf8");
      else if (ArrayBuffer.isView(originalBody)) requestBody = Buffer.from(originalBody.buffer, originalBody.byteOffset, originalBody.byteLength).toString("utf8");
      else if (originalBody instanceof Blob) requestBody = await originalBody.text();
      else if (originalBody instanceof FormData) requestBody = [...originalBody].map(([key, value]) => ({ [key]: typeof value === "string" ? value : { name: value.name, size: value.size, type: value.type } }));
    }
    emitDebugLog({ ...base, event: "request", requestHeaders: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)), requestBody });
    try {
      const response: Response = await fetchScope.run(true, () => Reflect.apply(transport, this, [actualInput, actualInit]));
      const fields = () => ({ ...base, status: response.status, requestId: response.headers.get("x-ai-request-id") ?? undefined, requestBody, responseHeaders: response.headers });
      const capture = captureBody(fields, started, /text\/event-stream/i.test(response.headers.get("content-type") ?? ""));
      if (!response.body) { capture.finish(); return response; }
      const observed = new Response(observeStream(response.body, capture), { status: response.status, statusText: response.statusText, headers: response.headers });
      for (const name of ["url", "redirected", "type"] as const) Object.defineProperty(observed, name, { value: response[name], configurable: true });
      return observed;
    } catch (error) {
      emitDebugLog({ ...base, event: "error", durationMs: Date.now() - started, requestBody, error: debugError(error) });
      throw error;
    }
  };
  observedFetch.add(wrapped);
  return wrapped;
}

function observeRequest(req: http.ClientRequest, protocol: string) {
  const started = Date.now();
  const chunks: Buffer[] = [];
  let requestBody: string | undefined;
  let completed = false;
  const fields = () => ({ layer, method: req.method, url: `${protocol}//${req.getHeader("host") ?? ""}${req.path}`, requestHeaders: req.getHeaders(), requestBody: requestBody ?? Buffer.concat(chunks).toString("utf8") });
  const remember = (chunk: unknown, encoding?: unknown) => {
    if (typeof chunk === "string") chunks.push(Buffer.from(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8"));
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
  };
  const write = req.write;
  req.write = function (this: http.ClientRequest, ...args: unknown[]) {
    const result = Reflect.apply(write, this, args);
    remember(args[0], args[1]);
    return result;
  } as typeof req.write;
  const end = req.end;
  req.end = function (this: http.ClientRequest, ...args: unknown[]) {
    const result = Reflect.apply(end, this, args);
    remember(args[0], args[1]);
    return result;
  } as typeof req.end;
  const emit = req.emit;
  req.emit = function (event: string | symbol, ...args: unknown[]) {
    if (event === "finish") {
      requestBody = Buffer.concat(chunks).toString("utf8");
      emitDebugLog({ ...fields(), event: "request" });
    } else if (event === "error") {
      completed = true;
      emitDebugLog({ ...fields(), event: "error", durationMs: Date.now() - started, error: debugError(args[0]) });
    } else if (event === "response") {
      const response = args[0] as http.IncomingMessage;
      const responseFields = () => ({ ...fields(), status: response.statusCode, requestId: response.headers["x-ai-request-id"], responseHeaders: response.headers });
      const capture = captureBody(responseFields, started, /text\/event-stream/i.test(String(response.headers["content-type"] ?? "")));
      const push = response.push;
      response.push = function (this: http.IncomingMessage, chunk: unknown, encoding?: BufferEncoding) {
        if (chunk === null) { completed = true; capture.finish(); }
        else if (typeof chunk === "string" || chunk instanceof Uint8Array) capture.add(chunk, encoding);
        return Reflect.apply(push, this, arguments);
      } as typeof response.push;
      const responseEmit = response.emit;
      response.emit = function (name: string | symbol, ...values: unknown[]) {
        if (name === "error") { completed = true; capture.finish(values[0]); }
        else if (name === "aborted") { completed = true; capture.finish(new Error("Response aborted")); }
        else if (name === "close" && !completed) { completed = true; capture.finish(undefined, true); }
        return Reflect.apply(responseEmit, this, [name, ...values]);
      };
    } else if (event === "close" && !completed) {
      completed = true;
      emitDebugLog({ ...fields(), event: "cancel", durationMs: Date.now() - started });
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
}

/** Activates service-process diagnostics only after the private debug-enable message. */
export function installDebugOutboundLogging(): void {
  if (installed || !debugLogEnabled()) return;
  installed = true;
  globalThis.fetch = debugOutboundFetch(globalThis.fetch);
  for (const module of [http, https]) {
    const request = module.request;
    module.request = function (this: typeof http | typeof https, ...args: unknown[]) {
      const req = Reflect.apply(request, this, args) as http.ClientRequest;
      if (debugLogEnabled() && !fetchScope.getStore()) observeRequest(req, module === https ? "https:" : "http:");
      return req;
    } as typeof module.request;
    module.get = function (this: typeof http | typeof https, ...args: unknown[]) {
      const req = Reflect.apply(module.request, this, args) as http.ClientRequest;
      req.end();
      return req;
    } as typeof module.get;
  }
  syncBuiltinESMExports();
}
