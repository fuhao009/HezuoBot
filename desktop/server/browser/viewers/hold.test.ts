import { afterEach, expect, it, vi } from "vitest";
import { ViewerHold } from "./hold.ts";
import type { HubHost, Viewer } from "./core.ts";

function fixture() {
  let owner: string | null = "person";
  let allowed = true;
  let changed = () => {};
  const release = vi.fn(async () => { owner = null; changed(); });
  const host = {
    holdLimits: { idleMs: 1000, graceMs: 1000 },
    control: { get owner() { return owner; }, canControl: () => allowed, onChange: (listener: () => void) => { changed = listener; }, letGo: async (_person: string, run: () => Promise<unknown>) => { await run(); } },
    release,
  } as unknown as HubHost;
  const driver = { closed: false, options: { person: "person", canOperate: true }, releaseInput: async () => true } as Viewer;
  const other = { closed: false, options: { person: "person", canOperate: true }, releaseInput: async () => true } as Viewer;
  const viewers = new Set([driver, other]);
  return { hold: new ViewerHold(host, viewers, () => {}), driver, other, release, viewers,
    unclaim: () => { owner = null; changed(); }, revoke: () => { allowed = false; } };
}
afterEach(() => vi.useRealTimers());

it("refreshes an existing authorized driver's lease without changing driver", async () => {
  vi.useFakeTimers();
  const { hold, driver, release } = fixture();
  await hold.took(driver);
  await vi.advanceTimersByTimeAsync(800);
  hold.renew(driver);
  await vi.advanceTimersByTimeAsync(800);
  expect(release).not.toHaveBeenCalled();
  expect(hold.driver).toBe(driver);
  await vi.advanceTimersByTimeAsync(201);
  expect(release).toHaveBeenCalledOnce();
});

it.each(["revoked", "unclaimed", "other-driver", "closed", "read-only", "removed"] as const)("renewal cannot acquire or extend %s control", async reason => {
  vi.useFakeTimers();
  const context = fixture();
  const { hold, driver, other, release } = context;
  await hold.took(driver);
  await vi.advanceTimersByTimeAsync(800);
  if (reason === "revoked") context.revoke();
  if (reason === "unclaimed") context.unclaim();
  if (reason === "closed") driver.closed = true;
  if (reason === "read-only") Object.assign(driver.options, { canOperate: false });
  if (reason === "removed") context.viewers.delete(driver);
  hold.renew(reason === "other-driver" ? other : driver);
  await vi.advanceTimersByTimeAsync(201);
  if (reason === "unclaimed") {
    expect(release).not.toHaveBeenCalled();
    expect(hold.driver).toBeNull();
  } else expect(release).toHaveBeenCalledOnce();
  expect(hold.driver).not.toBe(other);
});
