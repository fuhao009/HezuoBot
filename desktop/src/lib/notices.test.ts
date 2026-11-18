import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING } from "@/lib/onboarding";
import { dismissNotice, launchNotice, markLaunchNotice, nextNotice, noticeSeen, NOTICES, SIMPLE_MODE_NOTICE, type NoticeFacts } from "./notices";

let local: Map<string, string>, session: Map<string, string>;
beforeEach(() => {
  local = new Map();
  session = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => local.set(key, value) });
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

it("schedules only local guidance", () => {
  expect(NOTICES).toEqual([SIMPLE_MODE_NOTICE]);
});

it("waits for earlier unknown facts, skips seen notices and claims only one per launch", () => {
  const facts: NoticeFacts = { [SIMPLE_MODE_NOTICE]: null };
  expect(nextNotice(facts, () => false)).toBeNull();
  facts[SIMPLE_MODE_NOTICE] = true;
  expect(nextNotice(facts, () => false)).toBe(SIMPLE_MODE_NOTICE);
  expect(nextNotice(facts, id => id === SIMPLE_MODE_NOTICE)).toBeNull();
  expect(nextNotice(facts, id => id === SIMPLE_MODE_NOTICE, SIMPLE_MODE_NOTICE)).toBeNull();
});

it("ignores retired campaign claims left by an older app", () => {
  session.set("hezuo.launch.notice", "whats-new-2026-11");
  expect(launchNotice()).toBeNull();
  markLaunchNotice(SIMPLE_MODE_NOTICE);
  expect(launchNotice()).toBe(SIMPLE_MODE_NOTICE);
});

it("preserves local and onboarding dismissals", () => {
  const patch = dismissNotice(EMPTY_ONBOARDING, SIMPLE_MODE_NOTICE);
  expect(noticeSeen(undefined, SIMPLE_MODE_NOTICE)).toBe(true);
  expect(patch?.onboarding.hintsSeen).toContain(SIMPLE_MODE_NOTICE);
  local.clear();
  expect(noticeSeen({ ...EMPTY_ONBOARDING, hintsSeen: [SIMPLE_MODE_NOTICE] }, SIMPLE_MODE_NOTICE)).toBe(true);
});
