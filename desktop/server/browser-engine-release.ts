// Digests computed from the official GitHub assets on 2026-09-08; update pins only through a reviewed
// native end-to-end run. Windows requires an explicitly configured, reviewed project artifact.
export const AGENT_BROWSER_VERSION = "0.37.0";

export interface AgentBrowserReleaseAsset {
  /** `<platform>-<arch>`; Linux adds `-musl` on Alpine-style systems. */
  target: string;
  asset: string;
  sha256: string;
  bytes: number;
  /** A reviewed platform-specific vendor revision; other assets use the upstream version. */
  version?: string;
  /** Exact release URL for a reviewed vendor build, never a mutable latest URL. */
  url?: string;
}

const RELEASES = new Map<string, AgentBrowserReleaseAsset>([
  [
    "darwin-arm64",
    { target: "darwin-arm64", asset: "agent-browser-darwin-arm64", sha256: "da5a2b4ef7be8ba279b1258c542c33877f480b1951d0d94de607fc1528edd380", bytes: 12429360 },
  ],
  [
    "darwin-x64",
    { target: "darwin-x64", asset: "agent-browser-darwin-x64", sha256: "f402c96350ffd2adc68d0e5e4d83aa49cf7735fef29882a8866be36cc2fc67e9", bytes: 13588296 },
  ],
  [
    "linux-arm64",
    { target: "linux-arm64", asset: "agent-browser-linux-arm64", sha256: "0315a8c4f7bf167cc5fd5eeaea79009b0e6b5d2ae8b3057bf6f96be978483426", bytes: 12507840 },
  ],
  [
    "linux-musl-arm64",
    { target: "linux-musl-arm64", asset: "agent-browser-linux-musl-arm64", sha256: "db67c0e84e0668c052c2cbdca325c57f896e309c3723755dcdd65b700f8a2b52", bytes: 12369352 },
  ],
  [
    "linux-musl-x64",
    { target: "linux-musl-x64", asset: "agent-browser-linux-musl-x64", sha256: "5cff3bc7b2486867aba2901f92c9ce6029bd2a37951630d9feec1c5b3fee402e", bytes: 14092888 },
  ],
  [
    "linux-x64",
    { target: "linux-x64", asset: "agent-browser-linux-x64", sha256: "78e0c5a14a7fa1f3d1ae2acdbdcc94a047b435b998a8c505fcc49d7fa4935a49", bytes: 14253776 },
  ],
]);

export function agentBrowserReleaseUrl(asset: AgentBrowserReleaseAsset): string {
  return asset.url ?? `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${asset.asset}`;
}

export function agentBrowserReleaseVersion(asset: AgentBrowserReleaseAsset | null): string {
  return asset?.version ?? AGENT_BROWSER_VERSION;
}

/** The pinned asset for this machine, or null when no reviewed artifact is configured or published. */
export function resolveAgentBrowserReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl = false,
  env: NodeJS.ProcessEnv = process.env,
): AgentBrowserReleaseAsset | null {
  const key = platform === "linux" && musl ? `linux-musl-${arch}` : `${platform}-${arch}`;
  if (key === "win32-x64") {
    const url = env.HEZUO_BROWSER_ENGINE_WINDOWS_URL;
    const sha256 = env.HEZUO_BROWSER_ENGINE_WINDOWS_SHA256;
    const version = env.HEZUO_BROWSER_ENGINE_WINDOWS_VERSION;
    const bytes = Number(env.HEZUO_BROWSER_ENGINE_WINDOWS_BYTES);
    if (!url && !sha256 && !version && !env.HEZUO_BROWSER_ENGINE_WINDOWS_BYTES) return null;
    if (!url || !sha256 || !/^[a-f0-9]{64}$/i.test(sha256) || !version || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version) || !Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error("Configure HEZUO_BROWSER_ENGINE_WINDOWS_URL, SHA256, VERSION and BYTES with a reviewed project artifact.");
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("The Windows browser artifact must use an HTTPS URL without credentials.");
    return { target: key, asset: `agent-browser-win32-x64-${version}.exe`, url, sha256: sha256.toLowerCase(), version, bytes };
  }
  return RELEASES.get(key) ?? null;
}

export function missingAgentBrowserReleaseReason(platform: NodeJS.Platform, arch: string): string {
  return platform === "win32" && arch === "x64"
    ? "No reviewed Windows browser engine artifact is configured. Set HEZUO_BROWSER_ENGINE_WINDOWS_URL, HEZUO_BROWSER_ENGINE_WINDOWS_SHA256, HEZUO_BROWSER_ENGINE_WINDOWS_VERSION and HEZUO_BROWSER_ENGINE_WINDOWS_BYTES when building or installing the browser bundle, then rebuild or reinstall Hezuo."
    : `agent-browser publishes no build for ${platform}-${arch}`;
}
