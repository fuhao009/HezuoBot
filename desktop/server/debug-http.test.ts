import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { setDebugLogSink } from "../electron/debug-log.mjs";
import { captureApiDebugLog } from "./debug-http.ts";

let server: Server | undefined;
const records: Record<string, unknown>[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  records.length = 0;
  setDebugLogSink((record: Record<string, unknown>) => records.push(record));
  server = createServer((req, res) => { captureApiDebugLog(req, res); handler(req, res); });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/test`;
}
afterEach(async () => {
  setDebugLogSink(null);
  server?.closeAllConnections();
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  server = undefined;
});

describe("API debug observer", () => {
  it("preserves JSON request/response bodies and redacts secrets", async () => {
    const url = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.setHeader("x-ai-request-id", "request-123");
        res.end(Buffer.concat(chunks));
      });
    });
    const body = { password: "private-password", text: "unaltered conversation" };
    const response = await fetch(url, { method: "POST", body: JSON.stringify(body) });
    expect(await response.json()).toEqual(body);
    const logged = records.find(record => record.event === "response");
    expect(logged).toMatchObject({ method: "POST", status: 200, requestId: "request-123", requestBody: { password: "***", text: body.text }, responseBody: { password: "***", text: body.text } });
    expect(JSON.stringify(records)).not.toContain("private-password");
  });

  it("redacts multipart passwords while retaining other raw fields", async () => {
    const url = await listen((req, res) => {
      req.resume();
      req.on("end", () => res.end("ok"));
    });
    const body = '--test-boundary\r\nContent-Disposition: form-data; name="password"\r\n\r\nmultipart-secret\r\n--test-boundary\r\nContent-Disposition: form-data; name="text"\r\n\r\nconversation unchanged\r\n--test-boundary--\r\n';
    expect(await (await fetch(url, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test-boundary" }, body })).text()).toBe("ok");
    const logged = records.find(record => record.event === "request");
    expect(logged?.requestBody).toContain("conversation unchanged");
    expect(logged?.requestBody).toContain('name="password"');
    expect(JSON.stringify(records)).not.toContain("multipart-secret");
  });

  it("emits complete SSE events before finish, preserving split UTF8 and hiding split secrets", async () => {
    const release = deferred();
    const first = deferred();
    const url = await listen((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write('data: {"password":"split-');
      res.write('secret","text":"');
      const bytes = Buffer.from("你好");
      res.write(bytes.subarray(0, 1));
      res.write(bytes.subarray(1));
      res.write('"}\n\n');
      first.resolve();
      void release.promise.then(() => res.end('data: {"token":"tail-secret"}'));
    });
    const response = await fetch(url);
    await first.promise;
    const chunks = records.filter(record => record.event === "response-chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.responseBody).toContain("你好");
    expect(chunks[0]?.responseBody).toContain('"password":"***"');
    expect(records.some(record => record.event === "response")).toBe(false);
    release.resolve();
    expect(await response.text()).toBe('data: {"password":"split-secret","text":"你好"}\n\ndata: {"token":"tail-secret"}');
    expect(JSON.stringify(records)).not.toMatch(/split-secret|tail-secret/);
  });

  it("records premature response closure without changing abort behavior", async () => {
    const closed = deferred();
    const url = await listen((_req, res) => {
      res.on("close", closed.resolve);
      res.setHeader("content-type", "text/event-stream");
      res.write("data: started\n\n");
    });
    await new Promise<void>((resolve, reject) => {
      const outgoing = request(url, incoming => {
        incoming.once("data", () => { incoming.destroy(); resolve(); });
        incoming.on("error", () => {});
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
    await closed.promise;
    const closedRecord = records.find(record => record.event === "response-close");
    expect(closedRecord).toMatchObject({ status: 200, error: { name: "Error" } });
    expect(records.some(record => record.event === "response")).toBe(false);
    const firstError = records.find(record => record.event === "error");
    if (firstError) expect(closedRecord?.error).toEqual(firstError.error);
  });

  it("leaves stream methods untouched while disabled", async () => {
    const url = await listen((req, res) => {
      const push = req.push;
      const write = res.write;
      const end = res.end;
      expect(captureApiDebugLog(req, res)).toBeUndefined();
      expect(req.push).toBe(push);
      expect(res.write).toBe(write);
      expect(res.end).toBe(end);
      res.end("disabled");
    });
    setDebugLogSink(null);
    expect(await (await fetch(url)).text()).toBe("disabled");
    expect(records).toEqual([]);
  });
});
