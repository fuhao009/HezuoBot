// Starts disposable server instances for real pairing and authenticated requests.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { removeTempDir, waitForExit } from "../../desktop/server/testing/cleanup.ts";
import { freePortBlock } from "../../desktop/server/testing/ports.ts";

const SERVER_DIR = fileURLToPath(new URL("../../desktop/server/", import.meta.url));
export const CLOUD_HOST = "hezuo-t-5e6d7c8b9a0f.fly.dev";
const EDGE = { host: CLOUD_HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${CLOUD_HOST}` };
const parse = (text: string) => { try { return JSON.parse(text); } catch { return null; } };

export interface CloudSendFixture {
  root: string;
  desktopBase: string;
  cloudBase: string;
  /** The owner session, paired through the local server's real auth routes. */
  owner: string;
  ownerCapability: string;
  edge: typeof EDGE;
  answers: string[];
  logs(): string;
  local(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  onCloud(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  /** Local pairing only: no signed member, team identity or private-thread ownership. */
  pairLocal(label: string, scopes: Array<"admin" | "client">): Promise<string>;
  asSession(token: string | null, method: string, path: string, body?: unknown): ReturnType<CloudSendFixture["onCloud"]>;
  grant(label: string): Promise<{ origin: string; code: string; expiresAt: number }>;
  relaunch(options?: { kill?: boolean; cloud?: NodeJS.ProcessEnv }): Promise<void>;
  close(): Promise<void>;
}

function fakeOnePassword(at: string, token: string): string {
  const sdk = join(at, "node_modules", "@1password", "sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@1password/sdk", version: "0.5.0", main: "index.js" }));
  writeFileSync(join(sdk, "index.js"), `"use strict";
exports.createClient = async ({ auth }) => {
  if (auth !== ${JSON.stringify(token)}) throw new Error("error authenticating: invalid service account token");
  return {
    vaults: { list: async () => [{ id: "v1", title: "Shared with Hezuo" }] },
    items: { list: async () => [], getAll: async () => ({ individualResponses: [] }) },
  };
};
`);
  return at;
}

/** `cloudOnePasswordToken`: the token My Cloud's 1Password accepts (default: this computer's), so a test can make 1Password
 * refuse this computer's token on My Cloud. `toolCalls`: each turn on this computer makes that many tool calls first, so a
 * few turns make a conversation of several pages.
 * `env`: additional environment for both servers. `cloudEngine`: lines run at the start of My
 * Cloud's synthetic Claude CLI, to script its turns (fake-claude-cli.ts). */
export async function launchCloudSendFixture({ onePasswordToken, cloudOnePasswordToken = onePasswordToken, toolCalls = 0, env = {}, cloudEnv = {}, cloudEngine = "", desktopEngine = "", cloudSignedIn = true }: {
  onePasswordToken: string; cloudOnePasswordToken?: string; toolCalls?: number;
  env?: NodeJS.ProcessEnv;
  /** My Cloud's own environment only (a store limit, say). */
  cloudEnv?: NodeJS.ProcessEnv;
  cloudEngine?: string;
  /** The same for this computer's synthetic Claude CLI. */
  desktopEngine?: string;
  /** False: My Cloud's own Claude is signed out, as on a new Cloud. */
  cloudSignedIn?: boolean;
}): Promise<CloudSendFixture> {
  const root = mkdtempSync(join(tmpdir(), "hezuo-cloud-send-"));
  const ownerCapability = randomBytes(32).toString("base64url");
  const answers: string[] = [];
  let logs = "";
  const children = new Set<ChildProcess>();
  const remember = async (response: Response) => { answers.push(await response.clone().text()); return response; };

  async function start(name: string, own: NodeJS.ProcessEnv, port: number, extra: string[] = [], ipc = false, acceptedToken = onePasswordToken, calls = 0, engine = "", signedIn = true): Promise<ChildProcess> {
    const home = join(root, name);
    const dataDir = join(home, ".hezuo");
    mkdirSync(dataDir, { recursive: true });
    const cli = join(home, "fixture-claude.mjs");
    const tools = calls ? JSON.stringify(Array.from({ length: calls }, (_, i) => ({ name: "Bash", input: { command: `echo step ${i}` } }))) : "";
    writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify(${signedIn ? '{ loggedIn: true, email: "person@example.test" }' : '{ loggedIn: false, authMethod: "none" }'})); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
process.env.FAKE_CLAUDE_FIXTURE_DIR = ${JSON.stringify(home)};
${tools ? `process.env.FAKE_CLAUDE_TOOL_CALLS = ${JSON.stringify(tools)};` : ""}
${engine}
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
    if (!existsSync(join(dataDir, "config.json"))) writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
      ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi", "grok"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
    } }));
    const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; const admin = process.env.FIXTURE_ADMIN_STAND_IN; globalThis.fetch = async (url, init) => admin && String(url).startsWith("https://cloud.example.test/") ? real(admin + String(url).slice(26), init) : String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
    const child = spawn(process.execPath, ["--import", offline, ...extra, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, "..", ".."),
      env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, HEZUO_DATA_DIR: dataDir,
        HEZUO_PORT: String(port), HEZUO_WEBHOOK_PORT: String(port + 1), HEZUO_DUCKDB_DIR: fakeOnePassword(join(home, "native"), acceptedToken), ...env, ...own },
      stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc" as const] : [])],
    });
    children.add(child);
    child.on("close", () => children.delete(child));
    child.stdout?.on("data", (chunk) => { logs += chunk; });
    child.stderr?.on("data", (chunk) => { logs += chunk; });
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`${name} exited:\n${logs}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return child; } catch {}
      if (Date.now() > deadline) throw new Error(`${name} did not start:\n${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const parentPort = `data:text/javascript,${encodeURIComponent(`
    const listeners = [];
    Object.defineProperty(process, "parentPort", { value: {
      on(event, listener) { if (event === "message") listeners.push(listener); },
      postMessage(message) { process.send?.(message); },
    } });
    process.on("message", (data) => { for (const listener of listeners) listener({ data }); });
    process.channel?.unref();
  `)}`;
  const desktopPort = await freePortBlock([0, 1]);
  const desktopBase = `http://127.0.0.1:${desktopPort}`;
  const startDesktop = async () => {
    const child = await start("desktop", { HEZUO_DESKTOP_PARENT: "1" }, desktopPort, ["--import", parentPort], true, onePasswordToken, toolCalls, desktopEngine);
    child.send({ type: "hezuo:desktop-mutation-token", token: ownerCapability });
    return child;
  };
  let desktop = await startDesktop();
  const cloudPort = await freePortBlock([0, 1]);
  const cloudBase = `http://127.0.0.1:${cloudPort}`;
  const startCloud = (more: NodeJS.ProcessEnv = {}) => start("cloud", { HEZUO_PUBLIC_URL: `https://${CLOUD_HOST}`,
    ...cloudEnv, ...more }, cloudPort, [], false, cloudOnePasswordToken, 0, cloudEngine, cloudSignedIn);
  let cloud = await startCloud();

  const mintCode = async (label: string, scopes: Array<"admin" | "client"> = ["admin", "client"]) => {
    const response = await fetch(`${cloudBase}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, scopes }) });
    if (!response.ok) throw new Error(`Local pairing failed: ${response.status} ${await response.text()}`);
    const answer: unknown = await response.json();
    if (!answer || typeof answer !== "object" || !("code" in answer) || typeof answer.code !== "string") throw new Error("Local pairing returned no code");
    return answer.code;
  };
  const pairOwner = async () => {
    const paired = await fetch(`${cloudBase}/api/auth/pair`, { method: "POST", headers: { ...EDGE, "content-type": "application/json" }, body: JSON.stringify({ code: await mintCode("Hezuo app (Cloud)") }) });
    if (!paired.ok) throw new Error(`Owner pairing failed: ${paired.status}`);
    const session: unknown = await paired.json();
    if (!session || typeof session !== "object" || !("token" in session) || typeof session.token !== "string" || !session.token) {
      throw new Error("Owner pairing returned no token");
    }
    return session.token;
  };
  let owner = await pairOwner();
  const local = async (method: string, path: string, body?: unknown) => {
    const response = await remember(await fetch(`${desktopBase}${path}`, { method, headers: {
      "x-hezuo-desktop-owner": ownerCapability, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, body: parse(await response.text()) };
  };
  const asSession = async (token: string | null, method: string, path: string, body?: unknown) => {
    const response = await remember(await fetch(`${cloudBase}${path}`, { method, headers: { ...EDGE,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, body: parse(await response.text()) };
  };
  const onCloud = (method: string, path: string, body?: unknown) => asSession(owner, method, path, body);
  const pairLocal = async (label: string, scopes: Array<"admin" | "client">) => {
    const result = await asSession(null, "POST", "/api/auth/pair", { code: await mintCode(label, scopes) });
    if (result.status !== 200 || typeof result.body?.token !== "string" || !result.body.token) {
      throw new Error(`Local session pairing failed: ${result.status}`);
    }
    return result.body.token as string;
  };
  for (let tries = 0; (await local("GET", "/api/bots")).status !== 200 && tries < 50; tries++) await new Promise((resolve) => setTimeout(resolve, 100));

  return {
    root, desktopBase, cloudBase, get owner() { return owner; }, ownerCapability, edge: EDGE, answers, logs: () => logs, local, onCloud, pairLocal, asSession,
    async relaunch({ kill = true, cloud: cloudMore } = {}) {
      await waitForExit(desktop, { signal: kill ? "SIGKILL" : "SIGTERM" });
      if (cloudMore) {
        await waitForExit(cloud, { signal: "SIGTERM" });
        cloud = await startCloud(cloudMore);
        owner = await pairOwner();
      }
      desktop = await startDesktop();
      for (let tries = 0; (await local("GET", "/api/bots")).status !== 200 && tries < 50; tries++) await new Promise((resolve) => setTimeout(resolve, 100));
    },
    grant: async (label) => ({ origin: cloudBase, code: await mintCode(label), expiresAt: Date.now() + 300_000 }),
    async close() {
      for (const child of children) await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(root);
    },
  };
}
