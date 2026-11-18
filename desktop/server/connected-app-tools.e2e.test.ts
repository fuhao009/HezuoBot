import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment } from "../../scripts/control-hezuo.ts";
import { startFakeConnectedApps } from "./testing/fake-connected-apps.ts";
import { waitForExit } from "./testing/cleanup.ts";

type Bridge = { command: string; args: string[]; env: Record<string, string> };

/** Starts a mounted connected-apps bridge the way the engine would and asks it for its tools and one call. */
async function ask(bridge: Bridge, call: { name: string; arguments: Record<string, unknown> }) {
  const child: ChildProcessWithoutNullStreams = spawn(bridge.command, [...(bridge.command === process.execPath ? ["--experimental-strip-types", "--no-warnings"] : []), ...bridge.args], {
    env: { ...process.env, ...bridge.env }, stdio: "pipe",
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const request = async (id: number, method: string, params?: unknown) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    return JSON.parse((await lines.next()).value as string);
  };
  try {
    await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engine", version: "1" } });
    const listed = await request(2, "tools/list");
    if (!listed.result) throw new Error(`tools/list: ${JSON.stringify(listed).slice(0, 500)} via ${bridge.command} ${bridge.args.join(" ")}`);
    const names: string[] = listed.result.tools.map((tool: { name: string }) => tool.name);
    const answer = await request(3, "tools/call", call);
    return { names, answer };
  } finally {
    child.kill("SIGKILL");
  }
}

const acpBridge = (entry: { command: string; args: string[]; env: Array<{ name: string; value: string }> }): Bridge =>
  ({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) });

interface DirectComposio {
  env: Record<string, string>;
  close(): Promise<void>;
}

/** Direct project API, with the existing fake supplying only the upstream MCP responses. */
async function startDirectComposio(mcpUrl: string): Promise<DirectComposio> {
  let config: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/mcp") {
      const upstream = await fetch(mcpUrl, { method: req.method, headers: { "content-type": "application/json" }, body: raw || undefined });
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      return res.end(await upstream.text());
    }
    if (req.headers["x-api-key"] !== "ak_app_tools_fixture") return reply(401, { error: "invalid project key" });
    if (path === "/api/v3.1/auth_configs" || path === "/api/v3/toolkits") return reply(200, { items: [] });
    if (path === "/api/v3.1/connected_accounts") return reply(200, { items: ["gmail", "googlecalendar"].map((slug) => ({ id: `ca_${slug}`, status: "ACTIVE", toolkit: { slug } })) });
    if (path === "/api/v3.1/tool_router/session/trs_app_tools/toolkits") return reply(200, { items: ["gmail", "googlecalendar"].map((slug) => ({ slug, connected_account: { id: `ca_${slug}`, status: "ACTIVE" } })) });
    if (path === "/api/v3.1/tool_router/session" || path === "/api/v3.1/tool_router/session/trs_app_tools") {
      if (raw) config = { ...config, ...JSON.parse(raw) };
      return reply(req.method === "POST" ? 201 : 200, { session_id: "trs_app_tools", mcp: { type: "http", url: `${origin}/mcp` }, config });
    }
    return reply(404, { error: `Unexpected direct Composio request: ${req.method} ${path}` });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    env: { HEZUO_COMPOSIO_API: `${origin}/api/v3.1`, HEZUO_COMPOSIO_TOOLKITS_API: `${origin}/api/v3` },
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

it("a bot given Gmail by its app switch reaches gmail.search_emails by name on Claude and on an ACP engine alike", async () => {
  const apps = await startFakeConnectedApps();
  apps.emails.push({ messageId: "m-ada", threadId: "t-ada", messageTimestamp: new Date().toISOString(), subject: "Q3 numbers", sender: "Ada <ada@example.test>", preview: { body: "Here they are" } });
  const scratch = mkdtempSync(join(tmpdir(), "hezuo-app-tools-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate, FAKE_ACP_HANG_ON: "Find Ada's mail again",
  }, undefined, undefined, undefined, undefined, undefined, ["cline"]);
  let restarted: ChildProcess | undefined;
  let direct: DirectComposio | undefined;
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result).slice(0, 400)}`).toBe(expected);
    return result;
  };
  try {
    direct = await startDirectComposio(`${apps.url}/v1/mcp`);
    // The launcher intentionally strips backend overrides; restart the owned fixture with explicit loopback endpoints.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const env = { ...verificationServerEnvironment(process.env, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
      ...direct.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate, FAKE_ACP_HANG_ON: "Find Ada's mail again" };
    const log = openSync(fixture.info.logPath, "a", 0o600);
    try {
      restarted = spawn(process.execPath, verificationServerArgs(env), { env, stdio: ["ignore", log, log] });
    } finally {
      closeSync(log);
    }
    await expect.poll(async () => {
      try { return (await fetch(`${fixture.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
    await api("PUT", "/api/config", { composio: { apiKey: "ak_app_tools_fixture" } });
    const bot = (await api("POST", "/api/bots", { name: "Paul" }, 201)).bot;
    // The record an Apps switch left before it also wrote the tool list: Gmail on by scope, no tool granted.
    await api("PATCH", `/api/bots/${bot.id}`, { composio: true, connectorTools: {}, connectorScopes: { apps: { gmail: "read", googlecalendar: "read" } } });
    const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")).find((row: any) => row.id === bot.id);
    expect(saved.connectorTools).toEqual({ gmail: { tools: "*" }, googlecalendar: { tools: "*" } });

    const send = async (text: string, sendId: string) => api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId }, 202);
    await send("Find Ada's mail", "app-tools-e2e-send-0001");
    let claudeDump: any;
    await expect.poll(() => {
      try { claudeDump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return false; }
      return Boolean(claudeDump.mcpConfig?.mcpServers?.composio);
    }, { timeout: 20_000 }).toBe(true);
    const onClaude = await ask(claudeDump.mcpConfig.mcpServers.composio, { name: "gmail.search_emails", arguments: { query: "from:ada@example.test" } });
    expect(onClaude.names).toEqual(expect.arrayContaining(["gmail.search_emails", "gmail.read_email", "gmail.read_email_thread", "googlecalendar.list_events"]));
    expect(onClaude.names, "a read-only app offers no tool that writes").not.toContain("gmail.send_email");
    expect(JSON.parse(onClaude.answer.result.content[0].text).messages[0]).toMatchObject({ messageId: "m-ada", subject: "Q3 numbers" });
    expect(apps.calls.at(-1)).toMatchObject({ tool: "GMAIL_FETCH_EMAILS", arguments: { user_id: "me", query: "from:ada@example.test" } });
    writeFileSync(gate, "");
    await expect.poll(async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).messages
      .some((message: any) => message.role === "bot" && String(message.text).startsWith("reply to:")), { timeout: 20_000 }).toBe(true);

    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "cline", model: "cline-default" } });
    await send("Find Ada's mail again", "app-tools-e2e-send-0002");
    const mounts = `${join(fixture.info.dataDir, "cline-launch.json")}.mcp.json`;
    await expect.poll(() => existsSync(mounts), { timeout: 20_000 }).toBe(true);
    const composio = (JSON.parse(readFileSync(mounts, "utf8")) as any[]).find((entry) => entry.name === "composio");
    const onAcp = await ask(acpBridge(composio), { name: "gmail_search_emails", arguments: { query: "from:ada@example.test" } });
    const plain = (names: string[]) => names.filter((name) => /^(gmail|googlecalendar)[._]/.test(name)).map((name) => name.replace(".", "_")).sort();
    expect(plain(onAcp.names), "the same tools under the same names").toEqual(plain(onClaude.names));
    expect(onAcp.names).toContain("gmail_search_emails");
    expect(JSON.parse(onAcp.answer.result.content[0].text).messages[0]).toMatchObject({ messageId: "m-ada" });
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    await direct?.close();
    await apps.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
