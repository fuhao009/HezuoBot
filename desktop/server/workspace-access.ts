// Legacy hosted configuration remains fail-closed while the retired portal is removed.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestAuth } from "./request-auth.ts";
import type { SessionRegistry } from "./sessions.ts";

export interface WorkspaceAccessOptions {
  sessions: SessionRegistry;
  cookieName: string;
  closeSessionStreams(sessionId: string): void;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface WorkspaceAccess {
  handlePublic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  authorize(req: IncomingMessage, auth: RequestAuth): Promise<{ status: 401 | 403 | 503; error: string } | null>;
  revalidate(): Promise<void>;
}

export function hostedWorkspaceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HEZUO_ADMIN_URL !== undefined || env.HEZUO_ADMIN_WORKSPACE !== undefined || env.HEZUO_ADMIN_MEMBERSHIP !== undefined;
}

/** A partial setting is never standalone. */
export function hostedWorkspaceConfiguration(env: NodeJS.ProcessEnv = process.env): { admin: URL; tenant: URL; workspace: string; portalMembership: boolean } | null {
  try {
    const origin = (raw: string | undefined) => {
      if (!raw || raw !== raw.trim()) throw new Error("missing origin");
      const url = new URL(raw);
      if (url.protocol !== "https:" || (raw !== url.origin && raw !== `${url.origin}/`)) throw new Error("invalid origin");
      return url;
    };
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(env.HEZUO_ADMIN_WORKSPACE ?? "")) return null;
    if (env.HEZUO_ADMIN_MEMBERSHIP !== undefined && !["local", "portal"].includes(env.HEZUO_ADMIN_MEMBERSHIP)) return null;
    return { admin: origin(env.HEZUO_ADMIN_URL), tenant: origin(env.HEZUO_PUBLIC_URL), workspace: env.HEZUO_ADMIN_WORKSPACE!, portalMembership: env.HEZUO_ADMIN_MEMBERSHIP === "portal" };
  } catch { return null; }
}

/** A hosted workspace never issues pairing codes or email sign-in: people come in through the portal. */
export function workspaceMembership(env: NodeJS.ProcessEnv = process.env):
  { authority: "local" | "portal"; pairingCodes: boolean; peopleUrl?: string } {
  const hosted = hostedWorkspaceConfiguration(env);
  const pairingCodes = !hostedWorkspaceConfigured(env);
  if (!hosted?.portalMembership) return { authority: "local", pairingCodes };
  const people = new URL("/people", hosted.admin);
  people.search = new URLSearchParams({ workspace: hosted.workspace }).toString();
  return { authority: "portal", pairingCodes, peopleUrl: people.href };
}

/** Only on a dedicated, portal-managed server; never an HTTP setting or a desktop grant. */
export function sharedWorkspaceFullAccessConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HEZUO_SHARED_WORKSPACE_FULL_ACCESS === "1" && env.HEZUO_DESKTOP_PARENT !== "1" &&
    hostedWorkspaceConfiguration(env)?.portalMembership === true;
}

/** The retired hosted membership provider is unsupported; never grant local access in its place. */
export function createWorkspaceAccess(options: WorkspaceAccessOptions): WorkspaceAccess | null {
  if (hostedWorkspaceConfigured(options.env)) {
    throw new Error("Hosted workspace configuration is no longer supported. Remove HEZUO_ADMIN_URL, HEZUO_ADMIN_WORKSPACE and HEZUO_ADMIN_MEMBERSHIP before starting a local workspace.");
  }
  return null;
}
