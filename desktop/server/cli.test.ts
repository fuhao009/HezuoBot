import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyStartupPreferences, formatSessions, parseArgs, runAccess, runOnboardingCommand, serverEntry, type CliOptions } from "./server-control.ts";
import { browserSignInLines, pairingBlock, qrToString } from "./cli-pairing.ts";
import { readAdminActivityRange } from "./admin-activity.ts";
import { SetupCancelled } from "./cli-prompts.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const setup = vi.hoisted(() => ({ runSetup: vi.fn(), isSetupComplete: vi.fn(), readCliStartup: vi.fn(), saveCliStartup: vi.fn() }));
vi.mock("./cli-setup.ts", () => setup);

describe("hezuo command line", () => {
  it("parses commands and flags, and explains mistakes", () => {
    const serve = parseArgs(["serve", "--port", "9001", "--data-dir", "/tmp/x", "--label", "cab mini", "--tailscale", "--no-pair"], {});
    // --data-dir is resolved against the platform: C:\tmp\x on Windows.
    expect(serve).toMatchObject({ command: "serve", port: 9001, dataDir: resolve("/tmp/x"), label: "cab mini", tailscale: true, pair: false });
    expect(parseArgs(["pair", "--client", "--public-url", "https://h/"], {})).toMatchObject({ command: "pair", client: true, publicUrl: "https://h" });
    expect(parseArgs(["sessions", "revoke", "abc"], {})).toMatchObject({ command: "sessions", revoke: "abc" });
    expect(parseArgs([], { HEZUO_PORT: "8123" })).toMatchObject({ command: "start", port: 8123 });
    expect(parseArgs(["--port", "8125", "--no-open", "--local"], {})).toMatchObject({ command: "start", port: 8125, open: false, local: true });
    expect(parseArgs(["--help"], {})).toMatchObject({ command: "help" });
    expect(parseArgs(["-h"], {})).toMatchObject({ command: "help" });
    expect(parseArgs(["dance"], {})).toEqual({ error: 'unknown command "dance"' });
    expect(parseArgs(["serve", "--port"], {})).toEqual({ error: "--port needs a value" });
    expect(parseArgs(["serve", "--port", "70000"], {})).toEqual({ error: "--port must be 1-65535" });
    expect(parseArgs(["pair", "--public-url", "mini.example"], {})).toEqual({ error: "--public-url must start with http:// or https://" });
    expect(parseArgs(["serve", "--bogus"], {})).toEqual({ error: 'unknown argument "--bogus"' });
    expect(parseArgs(["setup", "--data-dir", "/tmp/cli-setup"], {})).toMatchObject({ command: "setup", dataDir: resolve("/tmp/cli-setup") });
    expect(parseArgs(["start", "--port", "8125", "--no-pair"], {})).toMatchObject({ command: "start", port: 8125, pair: false });
    expect(parseArgs(["browser", "install", "--with-deps"], {})).toMatchObject({ command: "browser", browserAction: "install", withDeps: true });
    expect(parseArgs(["browser", "status"], {})).toMatchObject({ command: "browser", browserAction: "status" });
    expect(parseArgs(["browser"], {})).toEqual({ error: "browser needs an action: install or status" });
    expect(parseArgs(["access", "add", "her@example.test", "--chat-only"], {})).toMatchObject({ command: "access", accessAction: "add", email: "her@example.test", chatOnly: true });
    expect(parseArgs(["access", "list"], {})).toMatchObject({ command: "access", accessAction: "list" });
    expect(parseArgs(["access"], {})).toEqual({ error: "access needs one of: list, add EMAIL [--chat-only], remove EMAIL" });
    expect(parseArgs(["access", "add"], {})).toEqual({ error: "add needs a value" });
    expect(parseArgs(["service", "uninstall"], {})).toMatchObject({ command: "service", serviceAction: "uninstall" });
    expect(parseArgs(["service", "install", "--sentinel"], {})).toMatchObject({ command: "service", serviceAction: "install", sentinel: true });
    expect(parseArgs(["serve", "--sentinel"], {})).toEqual({ error: expect.stringContaining("--sentinel") });
    expect(parseArgs(["service"], {})).toEqual({ error: expect.stringContaining("service needs one of") });
  });

  it.each(["login", "logout", "fleet"])("rejects the removed %s command", (command) => {
    expect(parseArgs([command], {})).toEqual({ error: `unknown command "${command}"` });
  });

  it.each(["--domain", "--tunnel", "--phone"])("rejects the removed %s flag", (flag) => {
    expect(parseArgs(["serve", flag], {})).toEqual({ error: `unknown argument "${flag}"` });
  });


  it("prints a scannable block with the link, or says where to type the code", () => {
    const block = pairingBlock({ code: "ABCD-EFGH-JKLM", url: "https://mini.example/pair#code=ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 });
    expect(block).toContain("pairing code:  ABCD-EFGH-JKLM");
    expect(block).toContain("open or scan:  https://mini.example/pair#code=ABCD-EFGH-JKLM");
    expect(block).toContain("(single use)");
    expect(block).toMatch(/[▀▄█]/);
    const noUrl = pairingBlock({ code: "ABCD-EFGH-JKLM", url: null, expiresAt: Date.now(), hint: "set HEZUO_PUBLIC_URL" });
    expect(noUrl).toContain("/pair on the address you use");
    expect(noUrl).toContain("set HEZUO_PUBLIC_URL");
    expect(qrToString("https://example.com").length).toBeGreaterThan(200);
  });

  it("adds a link that signs in a browser on this computer, which is no longer the owner by being here", () => {
    const local = "http://127.0.0.1:8799/pair#code=ABCD-EFGH-JKLM";
    const block = pairingBlock({ code: "ABCD-EFGH-JKLM", url: null, localUrl: local, expiresAt: Date.now() + 60_000, hint: "set HEZUO_PUBLIC_URL" });
    expect(block).toContain(`this computer: ${local}`);
    expect(block).toContain("/pair on the address you use");
    expect(block).not.toContain(qrToString(local));
    const guided = browserSignInLines(local, "ABCD-EFGH-JKLM", Date.now() + 60_000);
    expect(guided).toContain(local);
    expect(guided).toContain("ABCD-EFGH-JKLM");
    expect(guided).toContain("single use");
    expect(guided).toContain("hezuo pair");
  });

  describe("the two links one pairing window has", () => {
    const url = "https://mini.example/pair#code=ABCD-EFGH-JKLM";
    const invite = `hezuobot://pair?address=https%3A%2F%2Fmini.example&token=hezuo_pair_${"a".repeat(43)}&name=mini`;
    const block = (over: { url?: string | null; inviteUrl?: string | null } = {}) =>
      pairingBlock({ code: "ABCD-EFGH-JKLM", url, inviteUrl: invite, expiresAt: Date.now() + 60_000, ...over });


    it("prints the web QR and the generic app invite link", () => {
      const out = block();
      expect(out).toContain(qrToString(url));
      expect(out).not.toContain(qrToString(invite));
      expect(out).toContain(`app link:      ${invite}`);
      expect(out).toContain(`open or scan:  ${url}`);
    });

    it("prints a scannable generic deep link without a web URL", () => {
      const out = block({ url: null });
      expect(out).toContain(`app link:      ${invite}`);
      expect(out).toContain(qrToString(invite));
      expect(out).toContain("pairing code:  ABCD-EFGH-JKLM");
      expect(out).toContain("(single use)");
      expect(out).not.toContain("/pair on the address you use");
    });

    it("keeps the web QR when no deep link is available", () => {
      const out = block({ inviteUrl: null });
      expect(out).toContain(`open or scan:  ${url}`);
      expect(out).toContain(qrToString(url));
      expect(out).not.toContain("app link:");
    });

  });

  it("lists sessions as a table with relative last-seen times", () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    const table = formatSessions([
      { id: "a1", label: "My MacBook", scopes: ["admin", "client"], lastSeenAt: now - 30_000, expiresAt: now + 86_400_000 },
      { id: "b2", label: "", scopes: ["client"], lastSeenAt: now - 3 * 3_600_000, expiresAt: now + 86_400_000 },
    ], now);
    expect(table).toContain("My MacBook");
    expect(table).toContain("(unnamed)");
    expect(table).toMatch(/a1\s+My MacBook\s+admin\s+just now/);
    expect(table).toMatch(/b2\s+\(unnamed\)\s+client\s+3 h ago/);
    expect(table).toContain("sessions revoke <id>");
  });

  it("finds the server next to itself: bundled index.js in a package, the TypeScript source in a checkout", () => {
    const checkout = serverEntry(SERVER_DIR);
    expect(checkout.args[0]).toBe("--experimental-strip-types");
    expect(checkout.args[1]).toBe(join(SERVER_DIR, "index.ts"));
    expect(checkout.skillsDir).toBe(join(SERVER_DIR, "..", "..", "skills"));
  });
});

describe("terminal onboarding commands", () => {
  const inputTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const outputTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const terminal = (enabled: boolean) => {
    Object.defineProperty(process.stdin, "isTTY", { value: enabled, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: enabled, configurable: true });
  };
  afterEach(() => {
    if (inputTty) Object.defineProperty(process.stdin, "isTTY", inputTty);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    if (outputTty) Object.defineProperty(process.stdout, "isTTY", outputTty);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });
  const command = (name: "setup" | "start") => parseArgs([name, "--data-dir", join(process.env.HOME!, "onboarding"), "--port", "18451"], {}) as CliOptions;
  const io = () => ({ log: vi.fn(), error: vi.fn(), ask: vi.fn() });
  const preserveEnv = () => vi.stubEnv("HEZUO_DATA_DIR", process.env.HEZUO_DATA_DIR);
  const running = vi.fn().mockResolvedValue(false);
  const open = vi.fn().mockResolvedValue(true);
  const flow = { running, open };
  beforeEach(() => {
    running.mockResolvedValue(false);
    open.mockResolvedValue(true);
  });

  it("runs explicit setup once and explains how to start without launching a server", async () => {
    terminal(true);
    preserveEnv();
    const options = command("setup");
    const output = io();
    const serve = vi.fn();
    setup.runSetup.mockImplementation(async () => {
      expect(process.env.HEZUO_DATA_DIR).toBe(options.dataDir);
      return true;
    });
    expect(await runOnboardingCommand(options, output, serve, flow)).toBe(0);
    expect(setup.runSetup).toHaveBeenCalledWith({ dataDir: options.dataDir, port: options.port });
    expect(setup.isSetupComplete).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
    expect(output.log).toHaveBeenCalledWith(expect.stringContaining("Start with: hezuo"));
  });

  it("starts after first-time setup and passes through the requested serve options", async () => {
    terminal(true);
    preserveEnv();
    const options = command("start");
    setup.isSetupComplete.mockResolvedValue(false);
    setup.runSetup.mockResolvedValue(true);
    const serve = vi.fn().mockResolvedValue(0);
    expect(await runOnboardingCommand(options, io(), serve, flow)).toBe(0);
    expect(setup.runSetup).toHaveBeenCalledOnce();
    expect(serve).toHaveBeenCalledWith({ ...options, guided: true });
  });

  it("uses completed setup without prompting even when start has no terminal", async () => {
    terminal(false);
    preserveEnv();
    setup.isSetupComplete.mockResolvedValue(true);
    const serve = vi.fn().mockResolvedValue(7);
    expect(await runOnboardingCommand(command("start"), io(), serve, flow)).toBe(7);
    expect(setup.runSetup).not.toHaveBeenCalled();
    expect(serve).toHaveBeenCalledOnce();
  });

  it.each(["setup", "start"] as const)("refuses an unconfigured %s without a terminal", async (name) => {
    terminal(false);
    preserveEnv();
    setup.isSetupComplete.mockResolvedValue(false);
    const output = io();
    const serve = vi.fn();
    expect(await runOnboardingCommand(command(name), output, serve, flow)).toBe(1);
    expect(setup.runSetup).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("interactive terminal"));
  });

  it.each([false, new SetupCancelled()])("does not start after setup is cancelled (%s)", async (result) => {
    terminal(true);
    preserveEnv();
    setup.isSetupComplete.mockResolvedValue(false);
    if (result instanceof Error) setup.runSetup.mockRejectedValue(result);
    else setup.runSetup.mockResolvedValue(result);
    const serve = vi.fn();
    expect(await runOnboardingCommand(command("start"), io(), serve, flow)).toBe(130);
    expect(serve).not.toHaveBeenCalled();
  });

  it("uses a saved remote route on later starts without setup prompts", async () => {
    terminal(true);
    preserveEnv();
    setup.isSetupComplete.mockResolvedValue(true);
    setup.readCliStartup.mockReturnValue({ access: "tailscale" });
    const serve = vi.fn().mockResolvedValue(0);
    await runOnboardingCommand(command("start"), io(), serve, flow);
    expect(setup.runSetup).not.toHaveBeenCalled();
    expect(serve).toHaveBeenLastCalledWith(expect.objectContaining({ tailscale: true, guided: true }));
  });


  it("reopens an already-running workspace without setup, pairing, or a second server", async () => {
    terminal(true);
    preserveEnv();
    running.mockResolvedValue(true);
    const serve = vi.fn();
    expect(await runOnboardingCommand(command("start"), io(), serve, flow)).toBe(0);
    expect(open).toHaveBeenCalledWith(18451);
    expect(setup.runSetup).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });

  it("honors --no-pair and --no-open without saving an access choice", async () => {
    terminal(true);
    preserveEnv();
    setup.isSetupComplete.mockResolvedValue(true);
    const serve = vi.fn().mockResolvedValue(0);
    await runOnboardingCommand({ ...command("start"), pair: false, open: false }, io(), serve, flow);
    expect(setup.saveCliStartup).not.toHaveBeenCalled();
    expect(serve).toHaveBeenCalledWith(expect.objectContaining({ pair: false, open: false }));
  });

  it("does not claim --local changed an already-running public workspace", async () => {
    terminal(true);
    preserveEnv();
    running.mockResolvedValue(true);
    const output = io();
    const serve = vi.fn();
    expect(await runOnboardingCommand({ ...command("start"), local: true }, output, serve, flow)).toBe(1);
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("current connection was not changed"));
    expect(open).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });

  it("passes an explicit public URL through without persisting an access choice", async () => {
    terminal(true);
    preserveEnv();
    setup.isSetupComplete.mockResolvedValue(true);
    const options = { ...command("start"), publicUrl: "https://example.com" };
    const serve = vi.fn().mockResolvedValue(0);
    expect(await runOnboardingCommand(options, io(), serve, flow)).toBe(0);
    expect(setup.saveCliStartup).not.toHaveBeenCalled();
    expect(serve).toHaveBeenCalledWith(expect.objectContaining({ publicUrl: options.publicUrl }));
  });
});

describe("saved startup access", () => {
  const options = () => parseArgs([], {}) as CliOptions;
  it("keeps local launches local and supports a one-time local override", () => {
    expect(applyStartupPreferences(options(), { access: "local" })).toMatchObject({ tailscale: false, publicUrl: undefined });
    expect(applyStartupPreferences({ ...options(), local: true }, { access: "tailscale" })).toMatchObject({ tailscale: false, publicUrl: undefined });
  });
  it("explicit route flags take priority over saved settings", () => {
    expect(applyStartupPreferences({ ...options(), tailscale: true }, { access: "tailscale" })).toMatchObject({ tailscale: true });
  });
  it("refuses a saved URL that embeds a credential or points to localhost", () => {
    for (const publicUrl of ["https://localhost", "https://user:secret@example.com", "https://example.com/pair#code=secret"])
      expect(() => applyStartupPreferences(options(), { access: "public-url", publicUrl })).toThrow("not a valid HTTPS origin");
  });
});



describe("hezuo access", () => {
  it("edits the sign-in allow-list in config.json without a running server", async () => {
    const home = mkdtempSync(join(tmpdir(), "hezuo-cli-access-"));
    const dataDir = join(home, "data");
    const out: string[] = [];
    const err: string[] = [];
    const io = { log: (line: string) => out.push(line), error: (line: string) => err.push(line), ask: async () => "" };
    const base = { command: "access" as const, port: 1, dataDir, tailscale: false, client: false, pair: true, json: false };
    try {
      expect(await runAccess({ ...base, accessAction: "list" }, io)).toBe(0);
      expect(out.at(-1)).toMatch(/pairing codes only/);
      expect(await runAccess({ ...base, accessAction: "add", email: "Her@Example.test" }, io)).toBe(0);
      expect(await runAccess({ ...base, accessAction: "add", email: "@agentada.test", chatOnly: true }, io)).toBe(0);
      expect(await runAccess({ ...base, accessAction: "add", email: "not-an-email" }, io)).toBe(2);
      const saved = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
      expect(saved.signIn).toEqual({ admins: ["her@example.test"], members: ["@agentada.test"] });
      expect(await runAccess({ ...base, accessAction: "add", email: "her@example.test", chatOnly: true }, io)).toBe(0);
      expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).signIn).toEqual({ admins: [], members: ["@agentada.test", "her@example.test"] });
      out.length = 0;
      expect(await runAccess({ ...base, accessAction: "list" }, io)).toBe(0);
      expect(out.join("\n")).toMatch(/@agentada.test\s+chat and approvals/);
      expect(await runAccess({ ...base, accessAction: "remove", email: "her@example.test" }, io)).toBe(0);
      expect(await runAccess({ ...base, accessAction: "remove", email: "her@example.test" }, io)).toBe(1);
      expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).signIn).toEqual({ admins: [], members: ["@agentada.test"] });
      const rows = readAdminActivityRange(dataDir, { from: new Date(Date.now() - 600_000), to: new Date(Date.now() + 600_000) });
      expect(rows.map((row) => [row.action, row.actor.kind, row.changed])).toEqual([
        ["people.update", "cli", ["signIn.members"]],
        ["people.update", "cli", ["signIn.admins", "signIn.members"]],
        ["people.update", "cli", ["signIn.members"]],
      ]);
      expect(rows[0]!.after).toEqual({ "signIn.members": ["@agentada.test"] });
    } finally {
      await removeTempDir(home);
    }
  });
});
