import { describe, expect, it } from "vitest";

import { isUseMyComputerUrl, USE_MY_COMPUTER_URL } from "./use-my-computer.ts";

describe("Use my computer deep link", () => {
  it("uses the canonical HezuoBot scheme", () => {
    expect(USE_MY_COMPUTER_URL).toBe("hezuobot://use-my-computer");
    expect(isUseMyComputerUrl(USE_MY_COMPUTER_URL)).toBe(true);
    expect(isUseMyComputerUrl("  HEZUOBOT://USE-MY-COMPUTER  ")).toBe(true);
  });

  it("rejects unsupported schemes and unrelated links", () => {
    for (const value of [
      "hezuo://use-my-computer",
      "otherapp://use-my-computer",
      "hezuobot://use-my-computer/",
      "hezuobot://pair",
      "https://example.com/use-my-computer",
      "",
    ]) {
      expect(isUseMyComputerUrl(value)).toBe(false);
    }
  });
});
