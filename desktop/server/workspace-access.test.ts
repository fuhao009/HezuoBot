import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionRegistry } from "./sessions.ts";
import { createWorkspaceAccess, hostedWorkspaceConfiguration, hostedWorkspaceConfigured } from "./workspace-access.ts";

describe("workspace access configuration", () => {
  let dir: string;
  let sessions: SessionRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hezuo-workspace-access-"));
    sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const hosted = {
    HEZUO_ADMIN_URL: "https://admin.example.test",
    HEZUO_PUBLIC_URL: "https://workspace.example.test",
    HEZUO_ADMIN_WORKSPACE: "acme",
    HEZUO_ADMIN_MEMBERSHIP: "portal",
  };
  const options = (env: NodeJS.ProcessEnv) => ({ sessions, cookieName: "hezuo_session", closeSessionStreams: () => {}, env });

  it("does not install hosted authorization without hosted settings", () => {
    expect(hostedWorkspaceConfigured({})).toBe(false);
    expect(createWorkspaceAccess(options({}))).toBeNull();
    expect(createWorkspaceAccess(options({ HEZUO_PUBLIC_URL: hosted.HEZUO_PUBLIC_URL }))).toBeNull();
  });

  it.each([
    { HEZUO_ADMIN_URL: hosted.HEZUO_ADMIN_URL },
    { HEZUO_ADMIN_WORKSPACE: hosted.HEZUO_ADMIN_WORKSPACE },
    { HEZUO_ADMIN_MEMBERSHIP: hosted.HEZUO_ADMIN_MEMBERSHIP },
    { HEZUO_ADMIN_URL: "" },
    { HEZUO_ADMIN_WORKSPACE: "" },
    { HEZUO_ADMIN_MEMBERSHIP: "" },
    hosted,
    { ...hosted, HEZUO_ADMIN_MEMBERSHIP: "local" },
  ])("rejects hosted configuration even with an injected admin session: %j", (env) => {
    sessions.issue({ label: "Injected admin", scopes: ["admin"], email: "admin@example.test" });
    expect(hostedWorkspaceConfigured(env)).toBe(true);
    expect(() => createWorkspaceAccess(options(env))).toThrow(/no longer supported/);
  });

  it("parses valid hosted settings without enabling their retired provider", () => {
    expect(hostedWorkspaceConfiguration(hosted)).toMatchObject({ workspace: "acme", portalMembership: true });
    expect(() => createWorkspaceAccess(options(hosted))).toThrow(/no longer supported/);
  });

  it.each([
    { ...hosted, HEZUO_ADMIN_URL: "http://admin.example.test" },
    { ...hosted, HEZUO_PUBLIC_URL: "https://workspace.example.test/path" },
    { ...hosted, HEZUO_ADMIN_WORKSPACE: "INVALID" },
    { ...hosted, HEZUO_ADMIN_MEMBERSHIP: "unknown" },
  ])("rejects malformed hosted settings rather than falling back locally: %j", (env) => {
    expect(hostedWorkspaceConfiguration(env)).toBeNull();
    expect(() => createWorkspaceAccess(options(env))).toThrow(/no longer supported/);
  });
});
