import { debugLogEnabled, emitDebugLog, isDebugSecretKey } from "../electron/debug-log.mjs";
import type { RuntimeEvent } from "./contracts.ts";

const nativeDetails = new WeakMap<object, unknown>();

/** Keep full native tool data out of canonical history and renderer events. */
export function debugToolEvent<T extends object>(event: T, details: unknown): T {
  if (debugLogEnabled()) nativeDetails.set(event, details);
  return event;
}

export function copyDebugToolDetails(source: object, target: object): void {
  if (debugLogEnabled() && nativeDetails.has(source)) nativeDetails.set(target, nativeDetails.get(source));
}

function toolSecrets(value: unknown, tool: string, secrets = new Set<string>(), seen = new WeakSet<object>()): Set<string> {
  if (typeof value === "string") {
    try { toolSecrets(JSON.parse(value), tool, secrets); } catch { /* Ordinary tool text. */ }
    for (const match of value.matchAll(/(?:--?([\w.-]+)(?:\s+|=)|\b([\w]+)=)(?:"([^"]+)"|'([^']+)'|([^\s;]+))/g)) {
      if (isDebugSecretKey(match[1] ?? match[2])) secrets.add(match[3] ?? match[4] ?? match[5]);
    }
    return secrets;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return secrets;
  seen.add(value);
  const record = value as Record<string, unknown>;
  const sensitiveTarget = [record.selector, record.name, record.label, record.placeholder, record.inputType, record.type]
    .filter((value): value is string => typeof value === "string")
    .some(value => isDebugSecretKey(value.replace(/\s+/g, "-")) ||
      (value.match(/[\w.-]+/g) ?? []).some(name => isDebugSecretKey(name) || /^(?:one[._-]?time|verification|otp|pin)$/i.test(name)));
  for (const [key, item] of Object.entries(record)) {
    if ((isDebugSecretKey(key) ||
      (key === "code" && /login|auth|verify|otp/i.test(tool)) ||
      (sensitiveTarget && /^(?:value|text|content|input)$/i.test(key))) && typeof item === "string" && item) secrets.add(item);
    toolSecrets(item, tool, secrets, seen);
  }
  return secrets;
}

function hideToolSecrets(value: unknown, secrets: Set<string>, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) {
      text = text.split(secret).join("***");
      text = text.split(JSON.stringify(secret).slice(1, -1)).join("***");
    }
    return text;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => hideToolSecrets(item, secrets, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hideToolSecrets(item, secrets, seen)]));
  }
  return value;
}

/** Log the broadcast once, before per-viewer filtering, without changing its payload. */
export function logDebugBroadcast(payload: Record<string, unknown>, options: { adminOnly?: boolean; person?: string } = {}): void {
  if (!debugLogEnabled() || payload.type === "hezuo:debug-log" || payload.kind === "hezuo:debug-log") return;
  emitDebugLog(hideToolSecrets({ layer: "server->renderer", event: "broadcast", payload, audience: options }, toolSecrets(payload, "")) as Record<string, unknown>);
}

type ToolStart = { startedAt: number; threadId: string; turnId?: string; provider: string; providerInstanceId?: string; itemId?: string; tool?: string; secrets: Set<string> };

/** Observe before the bus folds live output into progress frames: output must not be lost or forwarded to the UI. */
export class DebugToolEvents {
  private readonly calls = new Map<string, ToolStart>();

  observe(event: RuntimeEvent): void {
    if (!debugLogEnabled()) {
      this.calls.clear();
      return;
    }
    const terminal = event.type === "turn.completed" || event.type === "cap.exhausted" || event.type === "session.exited" ||
      (event.type === "runtime.error" && event.terminal === true);
    if (terminal) {
      for (const [key, call] of this.calls) {
        if (call.threadId !== event.threadId || call.provider !== event.provider || call.providerInstanceId !== event.providerInstanceId ||
          (event.turnId !== undefined && call.turnId !== event.turnId)) continue;
        const { secrets, ...metadata } = call;
        emitDebugLog(hideToolSecrets({ layer: "bot-tool", event: "interrupted", ...metadata, durationMs: Math.max(0, Date.now() - call.startedAt),
          error: event, ok: false }, secrets) as Record<string, unknown>);
        this.calls.delete(key);
      }
      return;
    }
    if ((event.type !== "item.started" && event.type !== "item.output" && event.type !== "item.completed") || event.itemType !== "tool") return;
    const key = JSON.stringify([event.provider, event.providerInstanceId, event.threadId, event.turnId, event.itemId]);
    const now = Date.now();
    if (event.type === "item.started") {
      this.calls.set(key, { startedAt: now, threadId: event.threadId, turnId: event.turnId, provider: event.provider,
        providerInstanceId: event.providerInstanceId, itemId: event.itemId, tool: event.title,
        secrets: toolSecrets(nativeDetails.get(event) ?? event.input, event.title ?? "") });
    }
    const call = this.calls.get(key);
    const secrets = call?.secrets ?? new Set<string>();
    toolSecrets(nativeDetails.get(event), call?.tool ?? "", secrets);
    emitDebugLog(hideToolSecrets({ layer: "bot-tool", event: event.type, provider: event.provider, providerInstanceId: event.providerInstanceId,
      threadId: event.threadId, turnId: event.turnId, itemId: event.itemId, tool: call?.tool,
      durationMs: call ? Math.max(0, now - call.startedAt) : undefined, payload: event, details: nativeDetails.get(event),
      ...(event.type === "item.completed" ? { ok: event.ok, ...(!event.ok ? { error: event.output ?? "Tool reported failure" } : {}) } : {}) }, secrets) as Record<string, unknown>);
    if (event.type === "item.completed") this.calls.delete(key);
  }
}
