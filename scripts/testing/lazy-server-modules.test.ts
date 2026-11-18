// One static import anywhere makes esbuild run the module when the bundle loads, so each of these stays a first-use import.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);
const FIRST_USE_ONLY = /^\s*import\s+(?!type\b)[^;]*?from\s+["'](tar|undici)["']/m;

it("the server loads tar and undici at first use", () => {
  const files = [...new Set(execFileSync("git", ["ls-files", "-co", "--exclude-standard", "desktop/server", "packages/shared"], { cwd: ROOT, encoding: "utf8" }).split("\n"))]
    .filter((file) => file.endsWith(".ts") && !file.includes(".test.") && !file.includes("/testing/") && existsSync(new URL(file, ROOT)));
  expect(files.length).toBeGreaterThan(0);
  expect(files.filter((file) => FIRST_USE_ONLY.test(readFileSync(new URL(file, ROOT), "utf8")))).toEqual([]);
});
