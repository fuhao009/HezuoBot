import type { BrowserApprovalTarget } from "../../../packages/shared/runtime-events.ts";

export function browserApprovalTarget(builtInBrowser: boolean, tool: string, args: Record<string, unknown>): BrowserApprovalTarget | undefined {
  if (!builtInBrowser || tool !== "agent_browser_open" || typeof args.url !== "string") return undefined;
  try {
    const url = new URL(args.url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    return { operation: "open", origin: url.origin };
  } catch {
    return undefined;
  }
}
