import { HTTPError } from "./http";

const LEDGER_PAGE_LIMIT = 50;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

interface CursorValue {
  createdAt: number;
  id: string;
}

function base64URLEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64URLDecode(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new HTTPError(400, "invalid_cursor");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HTTPError(400, "invalid_cursor");
  }
}

export function encodeCursor(cursor: CursorValue): string {
  return base64URLEncode(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }));
}

/** A ledger cursor is opaque, but strictly validated: a malformed one is a
 * client error, never a silent restart from the beginning. */
export function decodeLedgerCursor(cursor: string): CursorValue {
  if (cursor.length === 0 || cursor.length > 256 || !CURSOR_PATTERN.test(cursor)) {
    throw new HTTPError(400, "invalid_cursor");
  }
  let value: unknown;
  try {
    value = JSON.parse(base64URLDecode(cursor));
  } catch (error) {
    if (error instanceof HTTPError) throw error;
    throw new HTTPError(400, "invalid_cursor");
  }
  if (typeof value !== "object" || value === null) throw new HTTPError(400, "invalid_cursor");
  if (!("createdAt" in value) || !("id" in value)) throw new HTTPError(400, "invalid_cursor");
  const { createdAt, id } = value;
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new HTTPError(400, "invalid_cursor");
  }
  if (typeof id !== "string" || id.length === 0 || id.length > 128) throw new HTTPError(400, "invalid_cursor");
  return { createdAt, id };
}

export function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return LEDGER_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) return LEDGER_PAGE_LIMIT;
  return Math.min(limit, LEDGER_PAGE_LIMIT);
}

export function cursorClause(
  table: string,
  idColumn: string,
  cursor: CursorValue | null,
): { sql: string; values: unknown[] } {
  if (!cursor) return { sql: "", values: [] };
  return {
    sql: ` AND (${table}.created_at < ? OR (${table}.created_at = ? AND ${table}.${idColumn} < ?))`,
    values: [cursor.createdAt, cursor.createdAt, cursor.id],
  };
}
