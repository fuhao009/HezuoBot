import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import type { McpServerSpec } from "../contracts.ts";
import type { McpOAuthManager } from "../mcp-oauth.ts";
import { APP_TOOLS_ENV } from "../connector-app-tools.ts";
import { createTeamConnectionsHost } from "./team-connections-host.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "local-connections-"));
  dirs.push(dataDir);
  const cfg = {} as AppConfig;
  const servers: Record<string, McpServerSpec> = {
    local: { command: "node", args: ["server.js"], env: {} },
    remote: { type: "http", url: "https://mcp.example.test", headers: { Authorization: "Bearer local-key" } },
  };
  const composio = {
    configured: vi.fn(() => true),
    mcpIntegration: vi.fn(async (_cfg: AppConfig, context: { commsToken: string }) => ({ command: "node", args: ["bridge"], env: { TOKEN: context.commsToken } })),
    connectedServices: vi.fn(async () => ({})),
    connectedServiceSlugs: vi.fn(async () => []), authorizeService: vi.fn(), removeService: vi.fn(),
  };
  const mcpOAuth = {
    authState: vi.fn(() => "not-required"),
    accessToken: vi.fn(async () => null),
    publicCallback: vi.fn(async () => ({ status: 200, text: "Signed in" })),
  };
  const mint = vi.fn(() => "turn-token");
  const host = createTeamConnectionsHost({ dataDir, audienceOf: () => "team", requester: () => null, isOwnerLive: () => true, cfg: () => cfg, harnessUrl: "http://127.0.0.1:1", mint,
    mcpOAuth: mcpOAuth as unknown as McpOAuthManager, botMcp: () => servers, composio });
  return { host, composio, mint, mcpOAuth, servers };
}

describe("the connected apps a turn's app tools come from", () => {
  afterEach(() => { vi.useRealTimers(); });
  const bot = { id: "scout", name: "Scout" };
  const GMAIL = { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [] } };
  const appTools = (bridges: { composio?: { env: Record<string, string> } }): string[] => JSON.parse(bridges.composio?.env[APP_TOOLS_ENV] ?? "[]");

  it("uses what is known at once, and reads it again in the background once it is a minute old, never waiting on that", async () => {
    vi.useFakeTimers();
    const { host, composio } = setup();
    composio.connectedServices.mockResolvedValue(GMAIL as never);
    host.primeApps();
    expect(composio.connectedServices, "read at start").toHaveBeenCalledTimes(1);
    expect(appTools(await host.appsIntegrations(bot, "main-chat", "g1"))).toContain("gmail.search_emails");
    expect(composio.connectedServices, "the read at start served the first turn").toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    let answer: (services: never) => void = () => {};
    composio.connectedServices.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    expect(appTools(await host.appsIntegrations(bot, "main-chat", "g2")), "the known answer while the new read hangs").toContain("gmail.search_emails");
    expect(composio.connectedServices).toHaveBeenCalledTimes(2);
    answer({} as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(appTools(await host.appsIntegrations(bot, "main-chat", "g3")), "Gmail was disconnected meanwhile").toEqual([]);
  });

  it("waits a few seconds at most for an installation's first answer, and reads again soon after a failed one", async () => {
    vi.useFakeTimers();
    const hanging = setup();
    hanging.composio.connectedServices.mockImplementation(() => new Promise<never>(() => {}));
    const first = hanging.host.appsIntegrations(bot, "main-chat", "g1");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(appTools(await first), "no answer yet: this turn goes without").toEqual([]);

    const { host, composio } = setup();
    composio.connectedServices.mockRejectedValueOnce(new Error("broker down")).mockResolvedValue(GMAIL as never);
    expect(appTools(await host.appsIntegrations(bot, "main-chat", "g1"))).toEqual([]);
    expect(appTools(await host.appsIntegrations(bot, "main-chat", "g2"))).toEqual([]);
    expect(composio.connectedServices, "not read again at once").toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(appTools(await host.appsIntegrations(bot, "main-chat", "g3"))).toContain("gmail.search_emails");
  });
});

describe("local connections", () => {
  const bot = { id: "scout", name: "Scout" };
  it("mints the app bridge for the current turn", async () => {
    const { host, mint } = setup();
    expect((await host.appsIntegrations(bot, "chat", "generation")).composio?.env.TOKEN).toBe("turn-token");
    expect(mint).toHaveBeenCalledWith({ botId: "scout", threadId: "chat", generation: "generation" });
  });
  it("keeps local MCP servers and their configured credentials", async () => {
    const { host, servers } = setup();
    expect(await host.turnMcp(bot, "chat", "generation")).toEqual(servers);
    expect(host.engineMcp(bot)).toEqual(servers);
  });
  it("uses the local MCP OAuth callback", async () => {
    const { host, mcpOAuth } = setup();
    expect(await host.mcpCallback("localhost", "?code=fixture")).toEqual({ status: 200, text: "Signed in" });
    expect(mcpOAuth.publicCallback).toHaveBeenCalledWith("localhost", "?code=fixture");
  });
});
