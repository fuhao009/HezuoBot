import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

it.each([
  { target: "server", postbuild: "node scripts/bundle-server.mjs" },
  { target: "companion", postbuild: "node scripts/mark-module-scope.mjs dist-companion" },
])("cleans deleted source outputs before $target emit, without touching workspace data", ({ target, postbuild }) => {
  const output = `dist-${target}`;
  const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const stages = scripts[`build:${target}`].split(" && ");
  expect(stages.slice(1)).toEqual([
    `tsc -p desktop/tsconfig.${target}.build.json`,
    postbuild,
  ]);
  const cleanup = /^node -e "(.+)"$/.exec(stages[0]);
  expect(cleanup).not.toBeNull();
  const cwd = mkdtempSync(join(tmpdir(), `hezuo-${target}-clean-`));
  try {
    const stale = [
      "hezuo.js",
      "enterprise/LICENSE",
      "desktop/server/devs-report-send.js",
      "desktop/server/highlevel/relay.js",
      "desktop/server/update-check.js",
      "desktop/server/pair-cli.js",
    ];
    for (const file of stale) {
      const path = join(cwd, output, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "deleted source output");
    }
    const data = join(cwd, "user-data", "messages.db");
    mkdirSync(dirname(data), { recursive: true });
    writeFileSync(data, "workspace data");
    execFileSync(process.execPath, ["-e", cleanup[1]], { cwd });
    expect(existsSync(join(cwd, output))).toBe(false);
    expect(readFileSync(data, "utf8")).toBe("workspace data");
    execFileSync(process.execPath, ["-e", cleanup[1]], { cwd });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
