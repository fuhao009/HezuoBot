import http, { createServer, request, get, type Server, type RequestListener } from "node:http";
import https, { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { setDebugLogSink } from "../electron/debug-log.mjs";
import { debugOutboundFetch, installDebugOutboundLogging } from "./debug-outbound.ts";

const records: Record<string, unknown>[] = [];
let server: Server | undefined;
async function listen(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/test`;
}
function enable() {
  records.length = 0;
  setDebugLogSink(record => records.push(record));
  installDebugOutboundLogging();
}
afterEach(async () => {
  setDebugLogSink(null);
  server?.closeAllConnections();
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  server = undefined;
});

it("does not inspect disabled fetch arguments and preserves failures", async () => {
  setDebugLogSink(null);
  const error = new Error("unchanged");
  const input = { toString() { throw new Error("must not inspect"); } } as unknown as string;
  const wrapped = debugOutboundFetch(async () => { throw error; });
  await expect(wrapped(input)).rejects.toBe(error);
});

it("updates existing named http/https imports and captures get without resuming its response", async () => {
  enable();
  expect(request).toBe(http.request);
  expect(httpsRequest).toBe(https.request);
  const url = await listen((_req, res) => { res.setHeader("x-ai-request-id", "id-1"); res.end('{"token":"hidden","text":"hello"}'); });
  await new Promise<void>((resolve, reject) => {
    get(url, response => {
      expect(response.readableFlowing).toBe(null);
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        expect(Buffer.concat(chunks).toString()).toContain("hidden");
        resolve();
      });
    }).on("error", reject);
  });
  expect(records.filter(record => record.event === "request")).toHaveLength(1);
  expect(records.find(record => record.event === "response")).toMatchObject({ status: 200, requestId: "id-1" });
  expect(JSON.stringify(records)).not.toContain("hidden");
});

it("preserves request write/end overloads callbacks and ordinary bodies", async () => {
  enable();
  const url = await listen((req, res) => { req.pipe(res); });
  let wrote = false;
  let ended = false;
  const text = await new Promise<string>((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { authorization: "Bearer hidden-header" } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on("error", reject);
    expect(typeof req.write('{"password":"hidden-', "utf8", () => { wrote = true; })).toBe("boolean");
    expect(req.end('body","message":"你好"}', () => { ended = true; })).toBe(req);
  });
  expect(wrote && ended).toBe(true);
  expect(text).toBe('{"password":"hidden-body","message":"你好"}');
  expect(records.filter(record => record.event === "request")).toHaveLength(1);
  expect(JSON.stringify(records)).not.toContain("hidden");
});

it("logs global fetch once with headers and response metadata", async () => {
  enable();
  const url = await listen((_req, res) => { res.setHeader("x-ai-request-id", "fetch-id"); res.end("ordinary"); });
  const response = await fetch(url, { headers: { authorization: "Bearer hidden" } });
  expect(response.url).toBe(url);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ordinary");
  expect(records.filter(record => record.event === "request")).toHaveLength(1);
  expect(records.find(record => record.event === "response")).toMatchObject({ requestId: "fetch-id", responseBody: "ordinary" });
  expect(JSON.stringify(records)).not.toContain("hidden");
});

it("does not pre-read response and propagates cancellation to the original stream", async () => {
  enable();
  let pulled = 0;
  let cancelled: unknown;
  const source = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode("first")); }, cancel(reason) { cancelled = reason; } }, { highWaterMark: 0 });
  const wrapped = debugOutboundFetch(async () => new Response(source, { headers: { "x-custom": "kept" } }));
  const response = await wrapped("http://fixture.test");
  expect(pulled).toBe(0);
  expect(response.headers.get("x-custom")).toBe("kept");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  expect(pulled).toBe(1);
  await reader.cancel("consumer-stop");
  expect(cancelled).toBe("consumer-stop");
  expect(records.at(-1)?.event).toBe("cancel");
});

it("logs incremental complete SSE frames and preserves UTF8 across split credentials", async () => {
  enable();
  const bytes = new TextEncoder().encode('data: {"token":"hidden-secret","text":"你好"}\n\ndata: [DONE]\n\n');
  let offset = 0;
  const wrapped = debugOutboundFetch(async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) controller.close();
    else controller.enqueue(bytes.subarray(offset, ++offset));
  } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }));
  expect(await (await wrapped("http://fixture.test")).text()).toContain("hidden-secret");
  const frames = records.filter(record => record.event === "chunk");
  expect(frames.map(record => record.chunkIndex)).toEqual([0, 1]);
  expect(frames[0]?.responseBody).toContain("你好");
  expect(JSON.stringify(records)).not.toContain("hidden-secret");
});

it("deduplicates custom fetch backed by node http and records transport errors", async () => {
  enable();
  const url = await listen((_req, res) => res.end("node transport"));
  const wrapped = debugOutboundFetch(async (input: Parameters<typeof fetch>[0]) => new Promise<Response>((resolve, reject) => {
    get(String(input), response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve(new Response(Buffer.concat(chunks))));
    }).on("error", reject);
  }));
  expect(await (await wrapped(url)).text()).toBe("node transport");
  expect(records.filter(record => record.event === "request")).toHaveLength(1);
  const error = Object.assign(new Error("network failed"), { cause: { code: "EHOSTUNREACH" } });
  await expect(debugOutboundFetch(async () => { throw error; })(url)).rejects.toBe(error);
  expect(JSON.stringify(records)).toContain("EHOSTUNREACH");
});

it("remains silent after sink disable and installation is idempotent", async () => {
  enable();
  const installedFetch = globalThis.fetch;
  const installedRequest = http.request;
  installDebugOutboundLogging();
  expect(globalThis.fetch).toBe(installedFetch);
  expect(http.request).toBe(installedRequest);
  setDebugLogSink(null);
  const url = await listen((_req, res) => res.end("no diagnostics"));
  expect(await (await fetch(url)).text()).toBe("no diagnostics");
  expect(records).toHaveLength(0);
});
