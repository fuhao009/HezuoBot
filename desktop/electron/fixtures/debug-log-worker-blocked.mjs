import { parentPort, workerData } from "node:worker_threads";
import { runDebugLogWorker } from "../debug-log-worker.mjs";

// The real writer cannot consume any queued record until the test releases it.
const gate = new Int32Array(workerData.gate);
parentPort.postMessage({ type: "fixture-blocked" });
Atomics.wait(gate, 0, 0);
runDebugLogWorker(parentPort, workerData);
