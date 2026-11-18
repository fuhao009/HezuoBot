import "../testing/scrub-ambient-hezuo-env.ts";

import { describe, expect, it, vi } from "vitest";

import { USAGE } from "../cli-usage.ts";
import { HEADLESS_VERBS } from "./args.ts";
import type { HeadlessIo } from "./output.ts";
import { runHeadless, VERB_HELP } from "./main.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
  return { io, out, err };
}

describe("the headless command line", () => {
  it("prints exactly one JSON document with --json, a failure included", async () => {
    const { io, out, err } = capture();
    const code = await runHeadless(["send", "--bot", "b1", "--json"], { io, env: {} });
    expect(code).toBe(2);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({ ok: false, error: "a message is required", hint: expect.any(String), exitCode: 2 });
    expect(err).toEqual([]);
  });

  it("writes errors to stderr without --json", async () => {
    const { io, out, err } = capture();
    expect(await runHeadless(["wait", "--bot", "b1", "--timeout", "forever"], { io, env: {} })).toBe(2);
    expect(out).toEqual([]);
    expect(err).toEqual(["error: --timeout must be a duration from 1s to 24h, such as 90, 90s, 5m or 2h"]);
  });

  it("redacts secrets in everything it prints", async () => {
    const { io, out, err } = capture();
    const callTool = vi.fn(async () => ({ messages: [{ role: "bot", kind: "text", text: "the key is sk-ant-abcdefghijklmnopqrstuv0123" }] }));
    expect(await runHeadless(["messages", "--bot", "b1", "--json"], { io, env: { HEZUO_URL: "http://127.0.0.1:19999" }, callTool })).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ messages: [{ role: "bot", kind: "text", text: expect.stringContaining("«redacted") }] });
    expect(out.join("\n")).not.toContain("sk-ant-abcdefghijklmnopqrstuv0123");
    expect(out.join("\n")).toContain("«redacted");
    const human = capture();
    expect(await runHeadless(["messages", "--bot", "b1"], { io: human.io, env: { HEZUO_URL: "http://127.0.0.1:19999" }, callTool })).toBe(0);
    expect(human.err).toEqual([]);
    expect(human.out).toHaveLength(1);
    expect(human.out[0]).toContain("«redacted");
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(human.out.join("\n")).not.toContain("sk-ant-abcdefghijklmnopqrstuv0123");
  });

  it("has plain help for every verb, and the main usage names them", async () => {
    for (const verb of HEADLESS_VERBS) expect(VERB_HELP[verb], verb).toBeTruthy();
    const { io, out } = capture();
    expect(await runHeadless(["help", "run"], { io })).toBe(0);
    expect(out[0]).toContain("Give a bot or room one job and wait until it, and every teammate it asked, is done.");
    expect(await runHeadless(["team", "apply", "--help"], { io })).toBe(0);
    expect(out[1]).toContain("a second apply prints \"No changes.\"");
    expect(USAGE).toContain("hezuo run BOT \"do this\"         give a bot one job and wait until it and every teammate it asked are done");
  });

});
