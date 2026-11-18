import type { AiModelConfig } from "./ai-config";
import { HTTPError } from "./http";
import type { TaskBillingSnapshot } from "./task-billing";

const CHAT_FIELDS = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "response_format",
  "reasoning_effort",
  "n",
  "service_tier",
]);

const RESPONSES_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "max_output_tokens",
  "temperature",
  "top_p",
  "reasoning",
  "text",
  "include",
  "store",
  "background",
  "service_tier",
]);

export interface PreparedRequest {
  model: AiModelConfig;
  outputCap: number;
  stream: boolean;
  upstream: Record<string, unknown>;
  inputReserve?: number;
  billing?: TaskBillingSnapshot;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const isString = (value: unknown): value is string => typeof value === "string";

export const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const invalid = (): HTTPError => new HTTPError(400, "invalid_request");

function rejectUnknownFields(body: Record<string, unknown>, allowed: ReadonlySet<string>) {
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw invalid();
}

function optionalNumber(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value !== undefined && !(typeof value === "number" && Number.isFinite(value))) throw invalid();
}

function optionalBoolean(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value !== undefined && typeof value !== "boolean") throw invalid();
}

function validateTools(tools: unknown) {
  if (tools === undefined) return;
  if (!Array.isArray(tools)) throw invalid();
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== "function") throw invalid();
    const chatShape = isRecord(tool.function) && isString(tool.function.name) && tool.function.name.length > 0;
    const responsesShape = isString(tool.name) && tool.name.length > 0;
    if (!chatShape && !responsesShape) throw invalid();
  }
}

export function prepareChat(body: Record<string, unknown>, model: AiModelConfig): PreparedRequest {
  rejectUnknownFields(body, CHAT_FIELDS);
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isRecord)) throw invalid();
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw invalid();
  if (body.n !== undefined && body.n !== 1) throw invalid();
  if (body.stream_options !== undefined) {
    const options = body.stream_options;
    if (!isRecord(options)) throw invalid();
    for (const key of Object.keys(options)) if (key !== "include_usage") throw invalid();
    if (options.include_usage !== undefined && typeof options.include_usage !== "boolean") throw invalid();
  }

  const maxTokens = body.max_tokens;
  const maxCompletion = body.max_completion_tokens;
  if (maxTokens !== undefined && maxCompletion !== undefined) throw invalid();
  const requested = maxTokens ?? maxCompletion;
  if (requested !== undefined && !isPositiveInteger(requested)) throw invalid();
  const outputCap = Math.min(requested ?? model.maxOutputTokens, model.maxOutputTokens);

  optionalNumber(body, "temperature");
  optionalNumber(body, "top_p");
  optionalNumber(body, "presence_penalty");
  optionalNumber(body, "frequency_penalty");
  optionalBoolean(body, "parallel_tool_calls");
  if (body.seed !== undefined && (typeof body.seed !== "number" || !Number.isSafeInteger(body.seed))) throw invalid();
  if (body.stop !== undefined && !isString(body.stop) && !(Array.isArray(body.stop) && body.stop.every(isString))) {
    throw invalid();
  }
  if (body.tool_choice !== undefined && !isString(body.tool_choice) && !isRecord(body.tool_choice)) throw invalid();
  if (body.response_format !== undefined && !isRecord(body.response_format)) throw invalid();
  if (body.reasoning_effort !== undefined && !isString(body.reasoning_effort)) throw invalid();
  validateTools(body.tools);

  const field = model.chatMaxTokensField;
  if (field !== "max_tokens" && field !== "max_completion_tokens") throw new HTTPError(503, "ai_unavailable");

  const stream = body.stream === true;
  const upstream: Record<string, unknown> = { ...body };
  delete upstream.max_tokens;
  delete upstream.max_completion_tokens;
  delete upstream.stream_options;
  upstream.model = model.upstreamModel;
  upstream.n = 1;
  upstream.stream = stream;
  upstream[field] = outputCap;
  // Terminal chat usage is what the wallet settles from.
  if (stream) upstream.stream_options = { include_usage: true };
  return { model, outputCap, stream, upstream };
}

export function prepareResponses(body: Record<string, unknown>, model: AiModelConfig): PreparedRequest {
  rejectUnknownFields(body, RESPONSES_FIELDS);
  const input = body.input;
  const inputValid = isString(input)
    ? input.length > 0
    : Array.isArray(input) && input.length > 0 && input.every((item) => isString(item) || isRecord(item));
  if (!inputValid) throw invalid();
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw invalid();
  if (body.instructions !== undefined && !isString(body.instructions)) throw invalid();
  if (body.background !== undefined && body.background !== false) throw invalid();
  if (body.store !== undefined && body.store !== false) throw invalid();
  if (body.include !== undefined) {
    if (!Array.isArray(body.include) || body.include.some((entry) => entry !== "reasoning.encrypted_content")) {
      throw invalid();
    }
  }
  const requested = body.max_output_tokens;
  if (requested !== undefined && !isPositiveInteger(requested)) throw invalid();
  const outputCap = Math.min(requested ?? model.maxOutputTokens, model.maxOutputTokens);
  optionalNumber(body, "temperature");
  optionalNumber(body, "top_p");
  optionalBoolean(body, "parallel_tool_calls");
  if (body.tool_choice !== undefined && !isString(body.tool_choice) && !isRecord(body.tool_choice)) throw invalid();
  if (body.reasoning !== undefined && !isRecord(body.reasoning)) throw invalid();
  if (body.text !== undefined && !isRecord(body.text)) throw invalid();
  validateTools(body.tools);

  const stream = body.stream === true;
  const upstream: Record<string, unknown> = { ...body };
  delete upstream.background;
  upstream.model = model.upstreamModel;
  // Remote storage and background execution stay off.
  upstream.store = false;
  upstream.max_output_tokens = outputCap;
  return { model, outputCap, stream, upstream };
}
