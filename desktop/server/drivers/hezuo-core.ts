// HezuoBot-Core driver — spawns Core's loopback web server per thread and
// wraps its poll-based HTTP API as the standard ProviderAdapter event stream.
// v1 scope: browser-backed text turns only (browserBackend: 'legacy').
// Not connected in v1: computer-use/AX, effort levels, cacheKeepWarm, streaming.
import { ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  RequestOutcome,
} from "../contracts.ts";
import { newEventId, newId, TurnNotStartedError } from "../contracts.ts";
import { z } from "zod";

const DRIVER_KIND = "hezuo-core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const configSchema = z.object({
  model: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().url().optional(),
  apiKeyEnv: z.string().trim().default("HEZUO_CORE_API_KEY"),
  system: z.string().optional(),
  browserHeadless: z.boolean().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
});

type CoreConfig = z.output<typeof configSchema>;

function decodeConfig(raw: unknown): CoreConfig {
  return configSchema.parse(raw ?? {});
}

// ---------------------------------------------------------------------------
// Port allocation helper
// ---------------------------------------------------------------------------

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Could not bind ephemeral port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Core process management per thread
// ---------------------------------------------------------------------------

/** Absolute path to core-engine src/web.ts (the loopback HTTP entry point). */
const CORE_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "core-engine",
  "src",
  "web.ts",
);

interface CoreSession {
  port: number;
  token: string;
  proc: ChildProcess;
  /** Tracks the latest message count so we know what is new. */
  lastMsgCount: number;
}

/** Start a Core process on an ephemeral port and wait for it to print the
 *  "HezuoBot Core: http://127.0.0.1:PORT" ready line. */
async function spawnCore(
  port: number,
  env: Record<string, string>,
): Promise<CoreSession> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", CORE_ENTRY],
      {
        env: { ...process.env, ...env, HEZUO_CORE_WEB_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      },
    );

    let started = false;
    let stderr = "";

    const onOut = (chunk: Buffer) => {
      const text = chunk.toString();
      if (!started && text.includes(`http://127.0.0.1:${port}`)) {
        // The state endpoint returns {token} on first GET; we fetch it.
        started = true;
        resolve({ port, token: "", proc, lastMsgCount: 0 });
      }
    };

    const onErr = (chunk: Buffer) => { stderr += chunk.toString(); };
    proc.stdout?.on("data", onOut);
    proc.stderr?.on("data", onErr);

    proc.on("error", (err) => { if (!started) reject(err); });
    proc.on("exit", (code) => {
      if (!started) reject(new Error(`Core exited (${code ?? "signal"}): ${stderr.slice(-400)}`));
    });

    // 10 s startup timeout
    const timer = setTimeout(() => {
      if (!started) {
        proc.kill();
        reject(new Error(`Core did not start within 10 s. stderr: ${stderr.slice(-400)}`));
      }
    }, 10_000);
    timer.unref();
  });
}

async function coreGet(session: CoreSession, path: string): Promise<unknown> {
  const resp = await fetch(`http://127.0.0.1:${session.port}${path}`, {
    headers: session.token ? { "x-session-token": session.token } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Core GET ${path} → ${resp.status}`);
  return resp.json();
}

async function corePost(
  session: CoreSession,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const resp = await fetch(`http://127.0.0.1:${session.port}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-session-token": session.token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Core POST ${path} → ${resp.status}`);
  return resp.json();
}

/** Fetch `/api/state` and return the parsed object. */
async function fetchState(session: CoreSession): Promise<{
  token: string;
  busy: boolean;
  closed: boolean;
  error: string;
  messages: Array<{ role: "user" | "assistant" | "error"; text: string }>;
}> {
  const data = await coreGet(session, "/api/state") as {
    token: string; busy: boolean; closed: boolean; error: string;
    messages: Array<{ role: "user" | "assistant" | "error"; text: string }>;
  };
  return data;
}

// ---------------------------------------------------------------------------
// Driver implementation
// ---------------------------------------------------------------------------

const DEFAULT_MODELS: ModelCatalog = {
  default: "set via API key env",
  options: [
    { id: "set via API key env", label: "HezuoBot Core (config)", custom: true },
  ],
};

export const HezuoCoreDriver: ProviderDriver<CoreConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "HezuoBot Core",
    supportsMultipleInstances: true,
    access: "api",
  },
  install: {
    docsUrl: "https://github.com/fuhao009/HezuoBot",
    settings: "connections",
    signInCommand:
      "Set HEZUO_CORE_MODEL and HEZUO_CORE_API_KEY in the server environment, then save.",
  },
  models: DEFAULT_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<CoreConfig>): Promise<ProviderInstance> {
    const { config, instanceId, displayName, environment } = input;

    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: RuntimeEvent) => {
      for (const l of Array.from(listeners)) l(event);
    };

    // Per-thread active state
    interface ThreadState {
      session: CoreSession;
      turnId: string;
      threadId: string;
      abort: AbortController;
    }
    const active = new Map<string, ThreadState>();

    // Build env for Core subprocess
    const buildEnv = (): Record<string, string> => {
      const env: Record<string, string> = {};
      const apiKey =
        (environment[config.apiKeyEnv ?? "HEZUO_CORE_API_KEY"] ??
          process.env[config.apiKeyEnv ?? "HEZUO_CORE_API_KEY"] ??
          "");
      if (apiKey) env.HEZUO_CORE_API_KEY = apiKey;
      if (config.model) env.HEZUO_CORE_MODEL = config.model;
      else {
        const m = environment.HEZUO_CORE_MODEL ?? process.env.HEZUO_CORE_MODEL;
        if (m) env.HEZUO_CORE_MODEL = m;
      }
      if (config.baseUrl) env.HEZUO_CORE_BASE_URL = config.baseUrl;
      else {
        const u = environment.HEZUO_CORE_BASE_URL ?? process.env.HEZUO_CORE_BASE_URL;
        if (u) env.HEZUO_CORE_BASE_URL = u;
      }
      if (config.system) env.HEZUO_CORE_SYSTEM = config.system;
      if (config.browserHeadless !== undefined)
        env.HEZUO_CORE_BROWSER_HEADLESS = String(config.browserHeadless);
      if (config.reasoningEffort) env.HEZUO_CORE_REASONING_EFFORT = config.reasoningEffort;
      // Always run browser headless in server context unless overridden
      if (!env.HEZUO_CORE_BROWSER_HEADLESS) env.HEZUO_CORE_BROWSER_HEADLESS = "true";
      return env;
    };

    const ensureSession = async (threadId: string): Promise<CoreSession> => {
      const existing = active.get(threadId);
      if (existing) return existing.session;
      const port = await allocatePort();
      const session = await spawnCore(port, buildEnv());
      // Fetch the session token from /api/state
      const state = await fetchState(session);
      session.token = state.token;
      return session;
    };

    const adapter = {
      provider: DRIVER_KIND,
      capabilities: {
        sessionModelSwitch: "unsupported" as const,
      },

      async sendTurn(turn: SendTurnInput) {
        const turnId = newId();
        const abort = new AbortController();

        // Lazily start Core subprocess for this thread
        let session: CoreSession;
        try {
          session = await ensureSession(turn.threadId);
        } catch (err) {
          throw new TurnNotStartedError(
            turnId,
            err instanceof Error ? err.message : "Core failed to start",
          );
        }

        active.set(turn.threadId, { session, turnId, threadId: turn.threadId, abort });

        const base = {
          eventId: newEventId(),
          provider: DRIVER_KIND,
          threadId: turn.threadId,
          turnId,
          createdAt: new Date().toISOString(),
        };

        // Emit turn.started
        emit({ ...base, eventId: newEventId(), type: "turn.started" });

        // Fire-and-forget the actual polling loop
        (async () => {
          try {
            // Handle sessionReset
            if (turn.sessionReset) {
              try { await corePost(session, "/api/reset", {}); } catch {}
            }

            // Send the message
            const sendBody: Record<string, unknown> = { text: turn.text };
            const sendResp = await fetch(
              `http://127.0.0.1:${session.port}/api/send`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-session-token": session.token,
                },
                body: JSON.stringify(sendBody),
                signal: abort.signal,
              },
            );
            if (!sendResp.ok) {
              const errText = await sendResp.text().catch(() => "");
              throw new Error(`Core rejected message (${sendResp.status}): ${errText}`);
            }

            // Poll until busy=false
            const POLL_MS = 400;
            let lastMsgCount = session.lastMsgCount;
            for (;;) {
              abort.signal.throwIfAborted();
              await new Promise((r) => setTimeout(r, POLL_MS));
              abort.signal.throwIfAborted();

              const state = await fetchState(session);
              // Emit new messages as item.completed events
              const newMsgs = state.messages.slice(lastMsgCount);
              for (const msg of newMsgs) {
                if (msg.role === "assistant") {
                  emit({
                    ...base,
                    eventId: newEventId(),
                    type: "item.completed",
                    itemType: "assistant_text",
                    text: msg.text,
                  });
                }
              }
              lastMsgCount = state.messages.length;
              session.lastMsgCount = lastMsgCount;

              if (!state.busy) {
                const ok = !state.error && !state.closed;
                emit({
                  ...base,
                  eventId: newEventId(),
                  type: "turn.completed",
                  ok,
                  stopReason: state.error ? "error" : "stop",
                });
                break;
              }
            }
          } catch (err) {
            const isAbort = abort.signal.aborted || (err instanceof Error && err.name === "AbortError");
            emit({
              ...base,
              eventId: newEventId(),
              type: "turn.completed",
              ok: false,
              stopReason: isAbort ? "interrupted" : "error",
            });
          } finally {
            if (active.get(turn.threadId)?.turnId === turnId) {
              active.delete(turn.threadId);
            }
          }
        })();

        return { turnId };
      },

      async interruptTurn(threadId: string) {
        const state = active.get(threadId);
        if (!state) return;
        state.abort.abort();
        try { await corePost(state.session, "/api/cancel", {}); } catch {}
      },

      respondToRequest(
        _threadId: string,
        _requestId: string,
        _decision: { behavior: "allow" | "deny" | "answer"; message?: string; always?: boolean },
      ): Promise<RequestOutcome> {
        // Core handles tool approval internally; harness approval is not wired in v1.
        return Promise.resolve("unavailable" as RequestOutcome);
      },

      hasSession(threadId: string): boolean {
        return active.has(threadId);
      },

      async stopAll() {
        for (const [, state] of Array.from(active)) {
          state.abort.abort();
          try { await corePost(state.session, "/api/cancel", {}); } catch {}
          state.session.proc.kill();
        }
        active.clear();
      },

      onEvent(listener: RuntimeEventListener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };

    const models: ModelCatalog = {
      default: config.model ?? "default",
      options: [{ id: config.model ?? "default", label: "HezuoBot Core", custom: true }],
    };

    const instance: ProviderInstance = {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: displayName ?? "HezuoBot Core",
      enabled: true,
      models,
      adapter,
      async snapshot(): Promise<ProviderSnapshot> {
        const model = config.model ?? process.env.HEZUO_CORE_MODEL ?? "";
        const apiKey =
          environment[config.apiKeyEnv ?? "HEZUO_CORE_API_KEY"] ??
          process.env[config.apiKeyEnv ?? "HEZUO_CORE_API_KEY"] ??
          "";
        if (!model) {
          return {
            state: "unavailable",
            reason: "Set HEZUO_CORE_MODEL in the server environment.",
          };
        }
        if (!apiKey) {
          return {
            state: "unavailable",
            reason: "Set HEZUO_CORE_API_KEY (or the configured env var) in the server environment.",
          };
        }
        return { state: "available", authenticated: true };
      },
      async dispose() {
        await adapter.stopAll();
      },
    };

    return instance;
  },
};
