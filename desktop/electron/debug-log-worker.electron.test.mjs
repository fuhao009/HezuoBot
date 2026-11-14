import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
function electronBinary() {
  const candidates = [];
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    for (const name of ["electron", "Electron.app/Contents/MacOS/Electron"]) candidates.push(path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, name));
  }
  try {
    const directory = path.dirname(require.resolve("electron/package.json"));
    candidates.push(path.join(directory, "dist", readFileSync(path.join(directory, "path.txt"), "utf8").trim()));
  } catch { /* Match the existing Electron smoke policy when the binary is unavailable. */ }
  return candidates.find(candidate => existsSync(candidate));
}
const electron = electronBinary();
const xvfb = process.platform === "linux" && !process.env.DISPLAY ? spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout.trim() : "";
const canRun = Boolean(electron) && (process.platform !== "linux" || Boolean(process.env.DISPLAY) || Boolean(xvfb));

it.runIf(canRun)("Electron's main-owned ESM worker rotates redacted records and drains before normal quit", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/debug-log-worker-smoke.mjs", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL|SESSION|OTP|OPERATOR|ELECTRON_RUN_AS_NODE/i.test(key)));
  const directory = mkdtempSync(path.join(tmpdir(), "hezuo-debug-worker-receipt-"));
  const receipt = path.join(directory, "result.json");
  try {
    const result = await new Promise(resolve => {
      const child = spawn(xvfb || electron, xvfb ? ["-a", electron, "--no-sandbox", fixture, receipt] : ["--no-sandbox", fixture, receipt], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { stderr += "\nfixture timed out"; child.kill("SIGKILL"); }, 30_000);
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      child.on("error", error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + error.message }); });
      child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    const evidence = existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) : { phase: "no-receipt" };
    const diagnostic = `receipt:\n${JSON.stringify(evidence)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.code, diagnostic).toBe(0);
    expect(evidence.complete, diagnostic).toBe(true);
    expect(evidence.count, diagnostic).toBe(20);
    expect(evidence.rotatedFiles, diagnostic).toBeGreaterThan(1);
    expect(evidence.shutdownDrained, diagnostic).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);
