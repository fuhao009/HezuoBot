import { afterEach, describe, expect, it, vi } from "vitest";
import { setDebugLogSink, type DebugLogRecord } from "../electron/debug-log.mjs";
import type { RuntimeEvent } from "./contracts.ts";
import { DebugToolEvents, debugToolEvent, logDebugBroadcast } from "./debug-events.ts";
import { EventBus } from "./harness/bus.ts";

const event = (fields: Record<string, unknown>): RuntimeEvent => ({ eventId: "event", provider: "fake", providerInstanceId: "engine-1",
  threadId: "thread-1", turnId: "turn-1", itemId: "call-1", createdAt: "2026-01-01T00:00:00.000Z", ...fields }) as RuntimeEvent;
const start = { type: "item.started", itemType: "tool", title: "Read", input: '{"path":"/tmp/readme","password":"hidden"}' };

function capture(): DebugLogRecord[] {
  const records: DebugLogRecord[] = [];
  setDebugLogSink(record => records.push(record));
  return records;
}

afterEach(() => { setDebugLogSink(null); vi.restoreAllMocks(); });

describe("server event debug logging", () => {
  it("records broadcast payload and audience once without changing data, excluding diagnostic transport", () => {
    const records = capture();
    const payload = { kind: "message", content: "hello", token: "secret" };
    logDebugBroadcast(payload, { adminOnly: true, person: "person@example.test" });
    logDebugBroadcast({ type: "hezuo:debug-log", record: {} });
    logDebugBroadcast({ kind: "hezuo:debug-log" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ layer: "server->renderer", event: "broadcast", payload: { kind: "message", content: "hello", token: "***" },
      audience: { adminOnly: true, person: "person@example.test" } });
    expect(payload.token).toBe("secret");
  });
  it("logs full native inputs and outputs privately and masks schema and echoed positional credentials", () => {
    const records = capture();
    const tools = new DebugToolEvents();
    const longText = "untruncated body ".repeat(1000);
    const input = { selector: 'input[type="password"]', value: "browser-private", command: "env API_KEY=command-private client --password 'argument-private'", document: longText };
    const started = event({ ...start, title: "browser_fill", input: "display preview" });
    expect(debugToolEvent(started, input)).toBe(started);
    expect(Object.keys(started)).not.toContain("details");
    tools.observe(started);
    tools.observe(debugToolEvent(event({ type: "item.completed", itemType: "tool", ok: false, output: "browser-private command-private argument-private" }), { output: longText, error: "browser-private command-private argument-private" }));
    expect(records[0].details).toMatchObject({ value: "***", command: "env API_KEY=*** client --password '***'" });
    expect(records[1].details).toMatchObject({ output: longText });
    expect(JSON.stringify(records)).not.toMatch(/browser-private|command-private|argument-private/);
    expect(input.value).toBe("browser-private");
  });

  it("preserves usage, pricing and token identifiers without masking their echoed values", () => {
    const records = capture();
    const ordinary = { input_tokens: "input-count", output_tokens: "output-count", cached_input_tokens: "cache-count",
      max_output_tokens: "limit-count", tokenId: "token-identifier", monkey: "ordinary-monkey",
      pricing: { input_token_price: 0.25, output_token_price: 0.5 } };
    const tools = new DebugToolEvents();
    const input = { ...ordinary, selector: 'input[name="tokenId"]', value: "identifier-field-value",
      command: "client --tokenId token-identifier --input_tokens input-count --access-token actual-command-secret",
      accountToken: "actual-account-secret" };
    tools.observe(debugToolEvent(event({ ...start, title: "browser_fill" }), input));
    tools.observe(debugToolEvent(event({ type: "item.completed", itemType: "tool", ok: true }),
      { ...ordinary, output: "input-count output-count cache-count limit-count token-identifier ordinary-monkey identifier-field-value actual-account-secret actual-command-secret" }));
    expect(records[0].details).toMatchObject({ ...ordinary, value: "identifier-field-value", accountToken: "***",
      command: "client --tokenId token-identifier --input_tokens input-count --access-token ***" });
    expect(records[1].details).toMatchObject({ ...ordinary,
      output: "input-count output-count cache-count limit-count token-identifier ordinary-monkey identifier-field-value *** ***" });
    expect(JSON.stringify(records)).not.toMatch(/actual-account-secret|actual-command-secret/);
  });

  it("recognizes credential selectors without matching tokenId or arbitrary substrings", () => {
    const records = capture();
    for (const selector of ['input[name="access_token"]', '#refreshToken', 'input[type="password"]', '#api_key', '#otp']) {
      logDebugBroadcast({ selector, value: "actual-field-secret", echo: "actual-field-secret" });
    }
    for (const selector of ['#tokenId', '#input_tokens', '#output_tokens', '#cached_input_tokens', '#max_output_tokens', '#monkey']) {
      logDebugBroadcast({ selector, value: "ordinary-field-value", echo: "ordinary-field-value" });
    }
    for (const record of records.slice(0, 5)) expect(record.payload).toMatchObject({ value: "***", echo: "***" });
    for (const record of records.slice(5)) expect(record.payload).toMatchObject({ value: "ordinary-field-value", echo: "ordinary-field-value" });
  });

  it("preserves private native details when the bus stamps adapter identity", async () => {
    const records = capture();
    const bus = new EventBus(() => {});
    let publish: ((event: RuntimeEvent) => void) | undefined;
    bus.attach([{ instanceId: "adapter-1", driverKind: "fake", adapter: {
      onEvent: (listener: (event: RuntimeEvent) => void) => { publish = listener; return () => {}; },
    } } as never]);
    publish!(debugToolEvent(event(start), { input: "full native input" }));
    publish!(event({ type: "item.completed", itemType: "tool", ok: true }));
    await bus.flush();
    expect(records[0]).toMatchObject({ providerInstanceId: "adapter-1", details: { input: "full native input" } });
    bus.detachAll();
  });


  it("records no broadcasts or tool events when disabled", () => {
    const records = capture();
    setDebugLogSink(null);
    logDebugBroadcast({ kind: "message" });
    const tools = new DebugToolEvents();
    tools.observe(event(start));
    tools.observe(event({ type: "item.output", itemType: "tool", text: "output" }));
    tools.observe(event({ type: "item.completed", itemType: "tool", ok: true }));
    expect(records).toEqual([]);
  });

  it("correlates interleaved engine, thread and turn tool calls and records failure output with duration", () => {
    const records = capture();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const tools = new DebugToolEvents();
    tools.observe(event(start));
    now.mockReturnValue(1100);
    tools.observe(event({ ...start, provider: "claude", providerInstanceId: "engine-2" }));
    tools.observe(event({ ...start, threadId: "thread-2" }));
    tools.observe(event({ ...start, turnId: "turn-2" }));
    now.mockReturnValue(1400);
    tools.observe(event({ type: "item.output", itemType: "tool", text: "live output", whole: true }));
    tools.observe(event({ type: "item.completed", itemType: "tool", ok: false, output: "file missing" }));
    now.mockReturnValue(1600);
    tools.observe(event({ type: "item.completed", itemType: "tool", ok: true, provider: "claude", providerInstanceId: "engine-2", output: "other engine" }));
    tools.observe(event({ type: "item.completed", itemType: "tool", ok: true, threadId: "thread-2" }));
    tools.observe(event({ type: "item.completed", itemType: "tool", ok: true, turnId: "turn-2" }));
    expect(records.filter(row => row.event === "item.completed").map(row => row.durationMs)).toEqual([400, 500, 500, 500]);
    expect(records.find(row => row.event === "item.output")).toMatchObject({ durationMs: 400, payload: { text: "live output", whole: true } });
    expect(records.find(row => row.event === "item.completed")).toMatchObject({ ok: false, error: "file missing", payload: { ok: false, output: "file missing" } });
    expect(JSON.stringify(records)).not.toContain("hidden");
  });

  it("records terminal errors for unfinished tools and forgets their timing", () => {
    const records = capture();
    const tools = new DebugToolEvents();
    tools.observe(event(start));
    tools.observe(event({ type: "runtime.error", message: "engine crashed", terminal: true }));
    tools.observe(event({ type: "item.completed", itemType: "tool", ok: false }));
    expect(records.find(row => row.event === "interrupted")).toMatchObject({ ok: false, error: { message: "engine crashed" }, durationMs: expect.any(Number) });
    expect(records.at(-1)?.durationMs).toBeUndefined();
  });

  it("captures live tool output before bus folding without forwarding or persisting output events", async () => {
    const records = capture();
    const persisted: string[] = [];
    const bus = new EventBus((_path, text) => { persisted.push(text); });
    const delivered: RuntimeEvent[] = [];
    bus.subscribe(value => delivered.push(value));
    bus.publish(event(start));
    bus.publish(event({ type: "item.output", itemType: "tool", text: "complete live diagnostic output" }));
    bus.publish(event({ type: "item.completed", itemType: "tool", ok: true, output: "done" }));
    await bus.flush();
    expect(records.filter(row => row.layer === "bot-tool").map(row => row.event)).toEqual(["item.started", "item.output", "item.completed"]);
    expect(delivered.some(row => row.type === "item.output")).toBe(false);
    expect(persisted.join("")).not.toContain("complete live diagnostic output");
  });

  it("does not let a failing diagnostic sink change bus delivery", async () => {
    const deliver = async () => {
      const bus = new EventBus(() => {});
      const delivered: RuntimeEvent[] = [];
      bus.subscribe(value => delivered.push(value));
      bus.publish(event(start));
      bus.publish(event({ type: "item.completed", itemType: "tool", ok: true }));
      await bus.flush();
      return delivered.map(row => row.type);
    };
    setDebugLogSink(null);
    const baseline = await deliver();
    setDebugLogSink(() => { throw new Error("writer unavailable"); });
    expect(await deliver()).toEqual(baseline);
  });
});
