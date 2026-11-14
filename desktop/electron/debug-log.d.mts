export interface DebugLogRecord {
  timestamp?: string;
  layer?: string;
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  requestId?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: unknown;
  event?: string;
  chunkIndex?: number;
  [key: string]: unknown;
}
export type DebugLogSink = (record: DebugLogRecord) => void;
export declare function setDebugLogSink(sink: DebugLogSink | null, options?: { redact?: boolean }): void;
export declare function debugLogEnabled(): boolean;
export declare function isDebugSecretKey(name: string): boolean;
export declare function sanitizeDebugLogRecord(record: DebugLogRecord): DebugLogRecord;
export declare function emitDebugLog(record: DebugLogRecord): void;
export declare function debugError(error: unknown): unknown;
export declare function createDebugLogWriter(options: { directory: string; maxBytes?: number; sanitized?: boolean; preserveTimestamp?: boolean }): DebugLogSink;
export declare function instrumentDebugFetch<T extends (input: any, init?: any) => Promise<Response>>(fetchImpl: T, layer: string): T;
