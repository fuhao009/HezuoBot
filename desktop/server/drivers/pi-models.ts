import type { ModelCatalog } from "../contracts.ts";
import { decodeInjectId, encodeInjectId } from "./local-inject.ts";

interface PiModelEntry {
  provider: string;
  id: string;
  name?: string;
}

export function piModelId(model: unknown): string | null {
  const entry = model as Partial<PiModelEntry> | null | undefined;
  return typeof entry?.provider === "string" && entry.provider && typeof entry.id === "string" && entry.id
    ? `${entry.provider}/${entry.id}` : null;
}
interface PiModelsResponse {
  type: "response";
  command: "get_available_models";
  success: boolean;
  data?: { models?: PiModelEntry[] };
}

export function piCatalogFromFrame(frame: unknown, fallbackDefault: string): ModelCatalog | null {
  const res = frame as PiModelsResponse;
  if (res?.type !== "response" || res.command !== "get_available_models" || !res.success) return null;
  const options: Array<{ id: string; label: string; custom: true; provider: string }> = [];
  for (const m of res.data?.models ?? []) {
    if (!m?.provider || !m?.id) continue;
    const id = `${m.provider}/${m.id}`;
    options.push({ id, label: m.name ?? m.id, custom: true, provider: m.provider });
  }
  return { default: fallbackDefault || (options[0]?.id ?? ""), options };
}

export function parsePiCatalog(stdout: string, fallbackDefault = ""): ModelCatalog {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const catalog = piCatalogFromFrame(msg, fallbackDefault);
    if (catalog) return catalog;
  }
  return { default: fallbackDefault, options: [] };
}

export function splitPiModel(id: string): { provider: string; modelId: string } | null {
  const inject = decodeInjectId(id);
  if (inject) return { provider: inject.host, modelId: inject.model };
  if (!id.includes("/")) return null;
  const [provider, ...rest] = id.split("/");
  if (!provider || !rest.length) return null;
  return { provider, modelId: rest.join("/") };
}

export function preferPiInjectRows(catalog: ModelCatalog): ModelCatalog {
  const injectIds = new Set(
    catalog.options.filter((option) => decodeInjectId(option.id)).map((option) => option.id),
  );
  if (!injectIds.size) return catalog;
  const options = catalog.options.filter((option) => {
    if (decodeInjectId(option.id)) return true;
    const slash = option.id.indexOf("/");
    if (slash <= 0) return true;
    return !injectIds.has(encodeInjectId(option.id.slice(0, slash), option.id.slice(slash + 1)));
  });
  let def = catalog.default;
  if (def && !options.some((option) => option.id === def)) {
    const slash = def.indexOf("/");
    const mapped = slash > 0 ? encodeInjectId(def.slice(0, slash), def.slice(slash + 1)) : "";
    def = injectIds.has(mapped) ? mapped : (options[0]?.id ?? "");
  }
  return { default: def, options };
}
