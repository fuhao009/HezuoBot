// Verification recipes are followed by hand, so nothing else notices when a
// command, file, route or link they cite stops existing. This reads every
// recipe under docs/verification and checks each citation against the tree.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HELP, verificationServerEnvironment } from "../control-hezuo.ts";
import { SessionRegistry } from "../../desktop/server/sessions.ts";
import { createWorkspaceAccess } from "../../desktop/server/workspace-access.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOCS = join(ROOT, "docs", "verification");
const recipes = readdirSync(DOCS).filter((name) => name.endsWith(".md")).sort();
const text = (recipe: string) => readFileSync(join(DOCS, recipe), "utf8");
// Paths inside external links belong to other repositories.
const withoutUrls = (markdown: string) => markdown.replace(/https?:\/\/\S+/g, " ");
const cited = (pattern: RegExp) => {
  const hits: string[] = [];
  for (const recipe of recipes) {
    for (const match of withoutUrls(text(recipe)).matchAll(pattern)) hits.push(`${recipe}: ${match[1]!}`);
  }
  return hits;
};
const target = (hit: string) => hit.slice(hit.indexOf(": ") + 2);

// The verbs `help` prints, minus the shell line under "isolated fixture".
const helpVerbs = new Set([...HELP.matchAll(/^ {2}([a-z][\w-]*)(?= |$)/gm)].map((match) => match[1]!).filter((verb) => verb !== "node"));
helpVerbs.add("help");

// Routes are registered in desktop/server/index.ts and in the modules under
// desktop/server/routes; tests there quote paths without registering them.
const ROUTES_DIR = join(ROOT, "desktop", "server", "routes");
// Including subfolders and the factories that live beside their feature.
const routeModules = readdirSync(ROUTES_DIR, { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort()
  .map((name) => join(ROUTES_DIR, name));
const featureRouteModules = ["data/routes.ts", "workspace-backup-http.ts"].map((name) => join(ROOT, "desktop", "server", name));
const serverSource = [join(ROOT, "desktop", "server", "index.ts"), ...routeModules, ...featureRouteModules]
  .map((file) => readFileSync(file, "utf8")).join("\n");
const hooksSource = readFileSync(join(ROOT, "desktop", "server", "webhook-ingress.ts"), "utf8");
// desktop/server/index.ts matches routes two ways: `path === "/api/x"` and
// `path.match(/^\/api\/x\/(a|b)$/)`. Collect the regex form too.
const routePatterns = [...serverSource.matchAll(/\/(\^\\\/api\\\/(?:\[(?:[^\]\\]|\\.)*\]|[^/\\\n[]|\\.)*)\/[a-z]*/g)].map((match) => new RegExp(match[1]!));
const PLACEHOLDER = /^(ID|:[\w-]+|<[^>]+>|\{[^}]+\})$/;

const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\w\- ]/g, "").replace(/\s+/g, "-");

describe("docs/verification recipes cite things that exist", () => {
  it("use control:hezuo verbs that help lists", () => {
    const used = cited(/pnpm control:hezuo ([a-z][\w-]*)/g);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((hit) => !helpVerbs.has(target(hit)))).toEqual([]);
    // the launcher form may also name `launch`, which pnpm cannot run
    const direct = cited(/scripts\/control-hezuo\.ts ([a-z][\w-]*)/g);
    expect(direct.filter((hit) => target(hit) !== "launch" && !helpVerbs.has(target(hit)))).toEqual([]);
  });

  it("cite source files that exist", () => {
    const refs = cited(/(?<![\w/.-])((?:scripts|server|src|shared|electron|companion|enterprise)\/[\w./-]+\.(?:ts|tsx|mjs|cjs|py))(?![\w/])/g);
    expect(refs.length).toBeGreaterThan(50);
    expect([...new Set(refs.filter((hit) => !existsSync(join(ROOT, target(hit)))))]).toEqual([]);
  });

  it("cite test files that exist", () => {
    const refs = cited(/(?<![\w/.-])([\w./-]+\.test\.(?:ts|mjs))(?![\w/])/g);
    expect(refs.length).toBeGreaterThan(20);
    expect([...new Set(refs.filter((hit) => !existsSync(join(ROOT, target(hit)))))]).toEqual([]);
  });

  it("cite API routes the server registers", () => {
    const refs = cited(/(?<!\w)(\/(?:api|hooks)\/[\w./:{}<>-]+)/g);
    expect(refs.length).toBeGreaterThan(5);
    const registered = (route: string) => {
      const path = route.replace(/[.,;:]+$/, "");
      const source = path.startsWith("/hooks/") ? hooksSource : serverSource;
      const segments = path.split("/").slice(1);
      const literal = segments.findIndex((segment) => PLACEHOLDER.test(segment));
      if (literal === -1) return source.includes(`"${path}"`) || routePatterns.some((pattern) => pattern.test(path));
      // a placeholder path is known by its first two segments
      const prefix = `/${segments.slice(0, Math.min(2, literal)).join("/")}`;
      return source.includes(`"${prefix}`) || source.includes(`${prefix}/`)
        || routePatterns.some((pattern) => pattern.test(segments.map((segment) => PLACEHOLDER.test(segment) ? "x-1" : segment).join("/").replace(/^/, "/")));
    };
    expect([...new Set(refs.filter((hit) => !registered(target(hit))))]).toEqual([]);
  });

  it("rejects retired hosted settings instead of granting local access", () => {
    const directory = mkdtempSync(join(tmpdir(), "hezuo-docs-fixture-"));
    const environment = verificationServerEnvironment({}, directory, 19975);
    const sessions = new SessionRegistry({ file: join(directory, "sessions.json") });
    try {
      const options = { sessions, cookieName: "hezuo_session", closeSessionStreams: () => {} };
      expect(createWorkspaceAccess({ ...options, env: environment })).toBeNull();
      sessions.issue({ label: "Injected admin", scopes: ["admin"], email: "admin@example.test" });
      for (const env of [
        { HEZUO_ADMIN_URL: "https://admin.example.test" },
        { HEZUO_ADMIN_WORKSPACE: "acme" },
        { HEZUO_ADMIN_MEMBERSHIP: "portal" },
        { HEZUO_ADMIN_URL: "" },
        { HEZUO_ADMIN_WORKSPACE: "" },
        { HEZUO_ADMIN_MEMBERSHIP: "" },
        { HEZUO_ADMIN_MEMBERSHIP: "local" },
      ]) {
        expect(() => createWorkspaceAccess({ ...options, env: { ...environment, ...env } })).toThrow(/no longer supported/);
      }
    } finally {
      sessions.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates fixture homes and excludes live credentials and hosted settings", () => {
    const dataDir = join(ROOT, ".fixture-docs-contract");
    const env = verificationServerEnvironment({ HOME: "/live", HEZUO_DATA_DIR: "/live/data", OPENAI_API_KEY: "sentinel-secret", HEZUO_ADMIN_URL: "https://admin.example.test", HEZUO_ADMIN_WORKSPACE: "acme", HEZUO_ADMIN_MEMBERSHIP: "portal" }, dataDir, 19975);
    expect(env).toMatchObject({ HOME: dataDir, USERPROFILE: dataDir, HEZUO_DATA_DIR: dataDir, HEZUO_PORT: "19975", HEZUO_WEBHOOK_PORT: "19976", HEZUO_TEST_SEALED_PATH: "1" });
    for (const key of ["OPENAI_API_KEY", "HEZUO_ADMIN_URL", "HEZUO_ADMIN_WORKSPACE", "HEZUO_ADMIN_MEMBERSHIP"]) expect(env[key], key).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("sentinel-secret");
  });

  it("are all reachable from README.md", () => {
    const linked = new Set([...text("README.md").matchAll(/\]\(([^)#\s]+\.md)/g)].map((match) => match[1]!));
    expect(recipes.filter((recipe) => recipe !== "README.md" && !linked.has(recipe))).toEqual([]);
  });

  it("link to files and headings that exist", () => {
    const broken: string[] = [];
    for (const recipe of recipes) {
      for (const [, link] of text(recipe).matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^(https?:|mailto:|#)/.test(link!)) continue;
        const [file, anchor] = link!.split("#");
        const resolved = resolve(DOCS, file!);
        if (!existsSync(resolved)) { broken.push(`${recipe}: ${link}`); continue; }
        if (anchor && resolved.endsWith(".md")) {
          const headings = [...readFileSync(resolved, "utf8").matchAll(/^#+\s+(.+)$/gm)].map((match) => slug(match[1]!));
          if (!headings.includes(anchor)) broken.push(`${recipe}: ${link} (no such heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
