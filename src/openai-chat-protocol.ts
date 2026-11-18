// Structured chat-completions calls. Assistant content becomes a tool call only for a local model, in chat-text-tool-calls.ts.
export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export class ChatProtocolError extends Error {}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Opaque provider reasoning blocks must keep their original order/signatures.
 * OpenRouter streams the sequence as arrays of blocks, not tool-call deltas. */
export class ChatReasoningDetails {
  readonly blocks: Record<string, unknown>[] = [];

  add(value: unknown): void {
    if (value === undefined || value === null) return;
    if (!Array.isArray(value) || value.some((block) => !object(block))) {
      throw new ChatProtocolError("provider returned invalid reasoning details");
    }
    this.blocks.push(...value);
  }
}

/** One accumulator per completion: indexes identify deltas; IDs correlate results. */
export class ChatToolCalls {
  private calls = new Map<number, ChatToolCall>();

  add(value: unknown, streaming: boolean): void {
    if (value === undefined || value === null) return;
    if (!Array.isArray(value)) throw new ChatProtocolError("provider returned invalid tool_calls");
    const omitted = (field: unknown) => field === undefined || (streaming && field === null);
    for (const [position, raw] of value.entries()) {
      const delta = object(raw);
      const index = !streaming ? position : delta?.index ?? this.slotOf(delta?.id);
      if (!delta || !Number.isSafeInteger(index) || Number(index) < 0) {
        throw new ChatProtocolError("provider returned an invalid tool-call index");
      }
      const call = this.calls.get(Number(index)) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (!omitted(delta.type) && delta.type !== "function") throw new ChatProtocolError("unsupported tool-call type");
      if (!omitted(delta.id)) {
        if (typeof delta.id !== "string" || !delta.id || (call.id && call.id !== delta.id)) {
          throw new ChatProtocolError("provider changed or omitted a tool-call ID");
        }
        call.id = delta.id;
      }
      if (delta.function !== undefined) {
        const fn = object(delta.function);
        if (!fn) throw new ChatProtocolError("provider returned an invalid tool-call function");
        for (const field of ["name", "arguments"] as const) {
          if (omitted(fn[field])) continue;
          if (typeof fn[field] !== "string") throw new ChatProtocolError("provider returned invalid tool-call arguments or name");
          call.function[field] += fn[field];
        }
      }
      this.calls.set(Number(index), call);
    }
  }

  /** Gemini's OpenAI-compatible endpoint streams each call whole, with an id and no index: the slot of the call with
   * that id, else the one after the last. */
  private slotOf(id: unknown): number | undefined {
    if (typeof id !== "string" || !id) return undefined;
    for (const [slot, call] of this.calls) if (call.id === id) return slot;
    let next = 0;
    for (const slot of this.calls.keys()) next = Math.max(next, slot + 1);
    return next;
  }

  finish(reason: string | null, malformedFrame: boolean): ChatToolCall[] {
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (malformedFrame) throw new ChatProtocolError("provider stream contained a malformed completion frame");
    if (reason === "function_call") throw new ChatProtocolError("legacy function_call is unsupported; use structured tool_calls");
    if (reason === "tool_calls" && !calls.length) throw new ChatProtocolError("provider ended for tool calls without a complete call");
    if (!calls.length) return calls;
    if (reason !== null && reason !== "tool_calls" && reason !== "stop") {
      throw new ChatProtocolError("provider tool calls were truncated or malformed");
    }
    const ids = new Set<string>();
    for (const call of calls) {
      if (!call.id || ids.has(call.id) || !/^[A-Za-z0-9_-]+$/.test(call.function.name)) {
        throw new ChatProtocolError("provider returned an incomplete or duplicate tool call");
      }
      ids.add(call.id);
    }
    return calls;
  }
}
