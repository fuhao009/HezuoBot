import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Every package the server loads at runtime through nativeRequire, which the bundle cannot include. */
function nativelyRequired() {
  const names = new Set();
  for (const file of readdirSync(join(root, "desktop", "server"), { recursive: true })) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    for (const [, name] of readFileSync(join(root, "desktop", "server", file), "utf8").matchAll(/nativeRequire\([^)]*\)\(\s*"([^"]+)"\s*\)/g)) names.add(name);
  }
  return [...names].sort();
}

describe("packaged native modules", () => {
  it("finds the Data engine, chart rendering and 1Password loads in the server", () => {
    expect(nativelyRequired()).toEqual(["@1password/sdk", "@duckdb/node-api", "@resvg/resvg-js"]);
  });

});
