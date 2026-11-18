import { describe, expect, it } from "vitest";

import { MASCOT_BODY_IDS } from "../shared/mascot-bodies.ts";
import { freshLook, STARTER_COLORS } from "./bot-look.ts";

describe("a new bot's first look", () => {
  it("is never a metal colour", () => {
    expect(STARTER_COLORS).not.toContain("silver");
    expect(STARTER_COLORS).not.toContain("chrome");
  });

  it("picks its colour at random, preferring one no bot here wears yet", () => {
    expect(freshLook([], () => 0).color).not.toBe(freshLook([], () => 0.999).color);
    const worn = [{ color: "red" as const }, { color: "blue" as const }];
    for (const roll of [0, 0.3, 0.6, 0.999]) expect(["red", "blue"]).not.toContain(freshLook(worn, () => roll).color);
  });

  it("picks its shape at random, preferring one no bot here wears yet", () => {
    expect(freshLook([], () => 0).mascotBody).not.toBe(freshLook([], () => 0.999).mascotBody);
    const worn = [{ color: "red" as const, mascotBody: "cursor" }, { color: "blue" as const, mascotBody: "star" }];
    for (const roll of [0, 0.3, 0.6, 0.999]) expect(["cursor", "star"]).not.toContain(freshLook(worn, () => roll).mascotBody);
    const all = MASCOT_BODY_IDS.map((mascotBody) => ({ color: "red" as const, mascotBody }));
    expect(MASCOT_BODY_IDS).toContain(freshLook(all, () => 0.5).mascotBody);
  });
});
