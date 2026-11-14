import type { IncomingMessage, ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { debugError, debugLogEnabled, emitDebugLog } from "../electron/debug-log.mjs";

function bodyValue(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/** Observe the existing reads/writes without starting request flow or changing backpressure. */
export function captureApiDebugLog(req: IncomingMessage, res: ServerResponse): { error(error: unknown): void } | undefined {
  if (!debugLogEnabled() || !/^\/api(?:\/|\?|$)/.test(req.url ?? "")) return undefined;
  const started = performance.now();
  const requestChunks: Buffer[] = [];
  const responseChunks: Buffer[] = [];
  const streamDecoder = new StringDecoder("utf8");
  let streamPending = "";
  let requestBody: unknown;
  let requestEnded = false;
  let completed = false;
  let streaming = false;
  let failure: unknown;
  const fields = () => {
    const requestId = res.getHeader("x-ai-request-id") ?? req.headers["x-ai-request-id"];
    return {
      timestamp: new Date().toISOString(), layer: "page->server", method: req.method ?? "GET", url: req.url ?? "/",
      status: res.statusCode, durationMs: performance.now() - started,
      requestId: typeof requestId === "string" ? requestId : undefined,
    };
  };
  const finishRequest = () => {
    if (requestEnded) return;
    requestEnded = true;
    requestBody = bodyValue(Buffer.concat(requestChunks).toString("utf8"));
    requestChunks.length = 0;
    emitDebugLog({ ...fields(), event: "request", requestBody });
  };
  const rememberError = (error: unknown) => {
    failure = debugError(error);
    emitDebugLog({ ...fields(), event: "error", error: failure });
  };
  // push observes network arrival even when a route rejects without consuming its body.
  const originalPush = req.push;
  req.push = function (chunk: unknown, encoding?: BufferEncoding): boolean {
    if (chunk === null) finishRequest();
    else if (!requestEnded && (typeof chunk === "string" || chunk instanceof Uint8Array)) {
      requestChunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
    }
    return originalPush.call(this, chunk, encoding);
  };
  const originalEmit = req.emit;
  req.emit = function (event: string | symbol, ...args: unknown[]): boolean {
    if (event === "error") rememberError(args[0]);
    else if (event === "aborted") rememberError(new Error("API request aborted"));
    return originalEmit.call(this, event, ...args);
  };
  const captureStream = (text: string, final = false) => {
    streamPending += text;
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(streamPending))) {
      const end = boundary.index + boundary[0].length;
      emitDebugLog({ ...fields(), event: "response-chunk", responseBody: streamPending.slice(0, end) });
      streamPending = streamPending.slice(end);
    }
    if (final && streamPending) {
      emitDebugLog({ ...fields(), event: "response-chunk", responseBody: streamPending });
      streamPending = "";
    }
  };
  const captureResponse = (chunk: unknown, encoding?: unknown) => {
    if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk)) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8")
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    streaming = String(res.getHeader("content-type") ?? "").includes("text/event-stream");
    if (streaming) {
      captureStream(streamDecoder.write(bytes));
    } else responseChunks.push(Buffer.from(bytes));
  };
  const originalWrite = res.write;
  res.write = function (this: ServerResponse, ...args: unknown[]): boolean {
    const result = Reflect.apply(originalWrite, this, args);
    captureResponse(args[0], args[1]);
    return result;
  } as typeof res.write;
  const originalEnd = res.end;
  res.end = function (this: ServerResponse, ...args: unknown[]): ServerResponse {
    // end() can synchronously emit finish, so capture its final bytes first.
    captureResponse(args[0], args[1]);
    return Reflect.apply(originalEnd, this, args);
  } as typeof res.end;
  const originalResponseEmit = res.emit;
  res.emit = function (event: string | symbol, ...args: unknown[]): boolean {
    if (event === "error") rememberError(args[0]);
    if ((event === "finish" || event === "close") && !completed) {
      completed = true;
      if (!requestEnded && req.complete) finishRequest();
      if (streaming) captureStream(streamDecoder.end(), true);
      emitDebugLog({
        ...fields(), event: event === "finish" ? "response" : "response-close", requestBody,
        responseBody: streaming ? undefined : bodyValue(Buffer.concat(responseChunks).toString("utf8")),
        ...(failure ? { error: failure } : event === "close" && !res.writableFinished ? { error: debugError(new Error("API response closed before completion")) } : {}),
      });
      responseChunks.length = 0;
    }
    return originalResponseEmit.call(this, event, ...args);
  };
  return { error: rememberError };
}
