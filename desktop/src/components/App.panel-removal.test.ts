import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

describe("App bot panel removal", () => {
  it("does not import or mount the computer side panel", () => {
    expect(app).not.toMatch(/\bComputerPanel\b/);
  });

  it("keeps bot settings behind the explicit settings state in a modal", () => {
    expect(app).toMatch(/\{state\.settingsOpen && bot && \(\s*<div className="fixed inset-0[^"]*">\s*<Suspense fallback=\{null\}>\s*<BotSettingsDialog\b/);
    expect(app.match(/<BotSettingsDialog\b/g)).toHaveLength(1);
  });
});
