import { describe, expect, it } from "vitest";

import { FRAME_SLACK_MS, FULL_FRAME_MS, SMALL_MASCOT_PX, frameFloorMs, nextFrameAt } from "./mascot-motion";

describe("frame timing", () => {
  it("lands the next frame on the interval grid", () => {
    expect(nextFrameAt(10_000, 50)).toBe(10_050);
    expect(nextFrameAt(10_020, 50)).toBe(10_050);
  });

  it("skips a grid line that is closer than the slack", () => {
    expect(nextFrameAt(10_050 - FRAME_SLACK_MS, 50)).toBe(10_100);
  });

  it("never schedules a resting figure", () => {
    expect(nextFrameAt(10_000, Infinity)).toBe(Infinity);
  });

  it("draws small figures at a third of the full rate", () => {
    expect(frameFloorMs(SMALL_MASCOT_PX)).toBeCloseTo(FULL_FRAME_MS * 3);
    expect(frameFloorMs(SMALL_MASCOT_PX + 1)).toBeCloseTo(FULL_FRAME_MS);
  });
});
