import type { DebugLogRecord } from "./debug-log.mjs";
import type { Worker } from "node:worker_threads";
export interface DebugLogWorkerOptions {
  directory: string;
  maxBytes?: number;
  maxQueueBytes?: number;
  maxQueueRecords?: number;
  onError?: (error: Error & { code?: string }) => void;
  createWorker?: (options: { directory: string; maxBytes?: number }) => Worker;
}
export declare function createDebugLogWorker(options: DebugLogWorkerOptions): {
  sink(record: DebugLogRecord): boolean;
  flush(): Promise<void>;
  close(): Promise<void>;
  abort(): void;
};
export declare function runDebugLogWorker(port: import("node:worker_threads").MessagePort, options: {
  directory: string; maxBytes?: number;
}): void;
