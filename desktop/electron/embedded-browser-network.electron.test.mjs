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
  } catch { /* An installation without a downloaded binary skips the smoke. */ }
  return candidates.find(candidate => existsSync(candidate));
}
const electron = electronBinary();
const xvfb = process.platform === "linux" && !process.env.DISPLAY ? spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout.trim() : "";
const canRun = Boolean(electron) && (process.platform !== "linux" || Boolean(process.env.DISPLAY) || Boolean(xvfb));

it.runIf(canRun)("embedded browser logs real network metadata and preserves native takeover state", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/embedded-browser-network-smoke.mjs", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL|SESSION|OTP|OPERATOR|ELECTRON_RUN_AS_NODE/i.test(key)));
  const directory = mkdtempSync(path.join(tmpdir(), "hezuo-browser-network-receipt-"));
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
    expect(evidence.takeover, diagnostic).toEqual({
      sameWebContents: true,
      profileCookiePreserved: true,
      focusesExisting: true,
      independentTitledWindows: true,
      closeReleaseIPC: true,
      humanScan: "manual, not exercised",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);
