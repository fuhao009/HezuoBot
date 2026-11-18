import { describe, expect, it } from "vitest";

import { BOT_BODY_IDS, botBodyId, botBodySchema, isHalloweenBody } from "./bot-body.ts";
import { HALLOWEEN_BODY_IDS } from "./halloween-bodies.ts";
import { MASCOT_BODY_IDS } from "./mascot-bodies.ts";

describe("bot bodies", () => {
  it("accepts every gradient body and every Halloween body", () => {
    expect(BOT_BODY_IDS).toEqual([...MASCOT_BODY_IDS, ...HALLOWEEN_BODY_IDS]);
    for (const id of BOT_BODY_IDS) expect(botBodySchema.safeParse(id).success).toBe(true);
  });

  it("falls back to the cursor for anything it does not know", () => {
    expect(botBodyId("pumpkin")).toBe("pumpkin");
    expect(botBodyId("star")).toBe("star");
    expect(botBodyId("hexagram")).toBe("cursor");
    expect(botBodyId(undefined)).toBe("cursor");
  });

  it("tells the Halloween bodies apart", () => {
    expect(isHalloweenBody("ghost")).toBe(true);
    expect(isHalloweenBody("cursor")).toBe(false);
    expect(isHalloweenBody(null)).toBe(false);
  });
});
