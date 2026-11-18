import {
  CloudflareAPI,
  CloudflareAPIError,
  type CloudflareDNSRecord,
  type CloudflareTunnel,
} from "./cloudflare-api";
import type { EndpointAccount } from "./config";
import { neverReady, snapshotFresh, type AccountSnapshot } from "./endpoint-accounts";

export type EndpointStatus = "pending" | "provisioning" | "ready" | "deleting" | "deleted" | "error";

export interface EndpointRow {
  installation_id: string;
  /** The Cloudflare account that holds this endpoint, for life. */
  provider_account: string;
  hostname: string;
  tunnel_name: string;
  tunnel_id: string | null;
  dns_record_id: string | null;
  status: EndpointStatus;
  generation: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  last_reconciled_at: number | null;
  delete_requested_at: number | null;
  last_error_code: string | null;
  cleanup_attempts: number;
  last_cleanup_attempt_at: number | null;
  reclaim_requested_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ClaimedEndpoint {
  leaseOwner: string;
  row: EndpointRow;
}

export const LEASE_MS = 60_000;

export class EndpointOperationError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryAfterSeconds: number | null = null,
    /** An ID, never the account: the account carries its API token. */
    public readonly accountId: string | null = null,
    public readonly tokenRefused = false,
  ) {
    super(code);
    this.name = "EndpointOperationError";
  }
}

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Read from D1 at most once per request. A failed read decides as if nothing
 * were known: the primary, no move, no gate. */
export interface Allocation {
  /** The version the app reported now, else the one it registered with. */
  appVersion: string | null;
  snapshots(): Promise<ReadonlyMap<string, AccountSnapshot>>;
}

export async function updateClaimedResources(
  env: Env,
  claim: ClaimedEndpoint,
  tunnelId: string | null,
  dnsRecordId: string | null,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET tunnel_id = ?, dns_record_id = ?, updated_at = ?
      WHERE installation_id = ? AND generation = ? AND lease_owner = ?`,
  ).bind(
    tunnelId,
    dnsRecordId,
    Date.now(),
    claim.row.installation_id,
    claim.row.generation,
    claim.leaseOwner,
  ).run();
  if (result.meta.changes === 0) throw new EndpointOperationError("lease_lost");
  claim.row.tunnel_id = tunnelId;
  claim.row.dns_record_id = dnsRecordId;
}

export async function renewClaim(env: Env, claim: ClaimedEndpoint): Promise<void> {
  const now = Date.now();
  const leaseExpiresAt = now + LEASE_MS;
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET lease_expires_at = ?, updated_at = ?
      WHERE installation_id = ? AND generation = ? AND lease_owner = ?
        AND lease_expires_at > ?`,
  ).bind(
    leaseExpiresAt,
    now,
    claim.row.installation_id,
    claim.row.generation,
    claim.leaseOwner,
    now,
  ).run();
  if (result.meta.changes === 0) throw new EndpointOperationError("lease_lost");
  claim.row.lease_expires_at = leaseExpiresAt;
}

export async function withClaimLease<T>(
  env: Env,
  claim: ClaimedEndpoint,
  operation: () => Promise<T>,
): Promise<T> {
  await renewClaim(env, claim);
  return operation();
}

export function expectedTunnelTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

function assertTunnelIdentity(
  claim: ClaimedEndpoint,
  tunnelId: string,
  tunnel: { id: string; name: string },
): void {
  if (tunnel.id !== tunnelId || tunnel.name !== claim.row.tunnel_name) {
    throw new EndpointOperationError("tunnel_identity_conflict");
  }
}

function assertDNSIdentity(
  claim: ClaimedEndpoint,
  tunnelId: string,
  dnsRecordId: string,
  record: { content: string; id: string; name: string; proxied: boolean; type: string },
): void {
  if (
    record.id !== dnsRecordId
    || record.name.toLowerCase() !== claim.row.hostname
    || record.type !== "CNAME"
    || record.content.toLowerCase() !== expectedTunnelTarget(tunnelId)
    || !record.proxied
  ) {
    throw new EndpointOperationError("dns_record_identity_conflict");
  }
}

async function reconcileDNSWriteResult(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  tunnelId: string,
  expectedRecordId: string | null,
): Promise<CloudflareDNSRecord | null> {
  const records = await withClaimLease(
    env,
    claim,
    () => api.listDNSRecords(claim.row.hostname),
  );
  if (records.length > 1) throw new EndpointOperationError("dns_record_conflict");
  const record = records[0];
  if (!record) return null;
  if (expectedRecordId && record.id !== expectedRecordId) {
    throw new EndpointOperationError("dns_record_conflict");
  }
  if (
    record.name.toLowerCase() !== claim.row.hostname
    || record.type !== "CNAME"
    || record.content.toLowerCase() !== expectedTunnelTarget(tunnelId)
    || !record.proxied
  ) {
    throw new EndpointOperationError("dns_record_conflict");
  }
  return record;
}

export async function verifiedTunnelForCleanup(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  tunnelId: string,
): Promise<CloudflareTunnel | null> {
  const tunnel = await withClaimLease(env, claim, () => api.getTunnel(tunnelId));
  const named = await withClaimLease(
    env,
    claim,
    () => api.listTunnels(claim.row.tunnel_name),
  );
  if (named.length > 1) throw new EndpointOperationError("tunnel_identity_conflict");
  if (!tunnel) {
    if (named.length !== 0) throw new EndpointOperationError("tunnel_identity_conflict");
    return null;
  }
  assertTunnelIdentity(claim, tunnelId, tunnel);
  if (named.length !== 1 || named[0]?.id !== tunnelId) {
    throw new EndpointOperationError("tunnel_identity_conflict");
  }
  return tunnel;
}

export async function verifiedDNSForCleanup(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  tunnelId: string,
  dnsRecordId: string,
): Promise<CloudflareDNSRecord | null> {
  const record = await withClaimLease(env, claim, () => api.getDNSRecord(dnsRecordId));
  const named = await withClaimLease(
    env,
    claim,
    () => api.listDNSRecords(claim.row.hostname),
  );
  if (named.length > 1) throw new EndpointOperationError("dns_record_identity_conflict");
  if (!record) {
    if (named.length !== 0) throw new EndpointOperationError("dns_record_identity_conflict");
    return null;
  }
  assertDNSIdentity(claim, tunnelId, dnsRecordId, record);
  if (named.length !== 1 || named[0]?.id !== dnsRecordId) {
    throw new EndpointOperationError("dns_record_identity_conflict");
  }
  return record;
}

/** What one reconcile holds in the account it is working in, and which of it
 * this request created, for its rollback. */
export interface HeldResources {
  createdDNSRecord: boolean;
  createdTunnel: boolean;
  dnsMayReferenceTunnel: boolean;
  dnsRecordId: string | null;
  tunnelId: string | null;
}

/** Re-fetched right before the destructive request: the stable name is our
 * identity fence, and a renamed or repurposed tunnel is retained. */
async function deleteVerifiedTunnel(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  tunnelId: string,
): Promise<void> {
  const tunnel = await verifiedTunnelForCleanup(env, claim, api, tunnelId);
  if (tunnel) {
    await renewClaim(env, claim);
    await api.deleteTunnel(tunnelId);
  }
}

export async function rollbackCreatedResources(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  state: HeldResources,
): Promise<{ dnsRecordId: string | null; tunnelId: string | null }> {
  let { dnsRecordId, tunnelId } = state;
  if (!state.createdDNSRecord && !state.createdTunnel) return { dnsRecordId, tunnelId };
  if (tunnelId) await verifiedTunnelForCleanup(env, claim, api, tunnelId);

  if (state.createdDNSRecord && dnsRecordId && tunnelId) {
    const record = await verifiedDNSForCleanup(env, claim, api, tunnelId, dnsRecordId);
    if (record) {
      await renewClaim(env, claim);
      await api.deleteDNSRecord(dnsRecordId);
    }
    dnsRecordId = null;
    await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
  }

  if (
    state.createdTunnel
    && tunnelId
    && (!state.dnsMayReferenceTunnel || (state.createdDNSRecord && !dnsRecordId))
  ) {
    await deleteVerifiedTunnel(env, claim, api, tunnelId);
    tunnelId = null;
    await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
  }

  return { dnsRecordId, tunnelId };
}

/** A row that never handed out its address keeps no tunnel in an account
 * whose zone refused its DNS record, whether this request created the tunnel
 * or adopted it, so its next request is answered by the account's refusal
 * gate or may move. A provider failure here leaves `refusal` the outcome. */
export async function giveBackTunnel(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  held: HeldResources,
  refusal: unknown,
): Promise<void> {
  const tunnelId = held.tunnelId;
  if (!tunnelId) return;
  try {
    await deleteVerifiedTunnel(env, claim, api, tunnelId);
  } catch (error) {
    throw error instanceof EndpointOperationError ? error : refusal;
  }
  held.tunnelId = null;
  held.createdTunnel = false;
  await updateClaimedResources(env, claim, null, held.dnsRecordId);
}

/** Cloudflare answers tunnel creation with 429 both for its API rate limit and,
 * at an account's tunnel quota, instead of error 1045. Nothing was created
 * either way. At or over the account's limit (by tunnel count, or else its last
 * scan less what cleanup deleted since) it is the quota; otherwise a rate limit. */
async function classifyCreate429(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  account: EndpointAccount,
  allocation: Allocation,
  rateLimited: CloudflareAPIError,
): Promise<Error> {
  let count: number | null = null;
  try {
    count = await withClaimLease(env, claim, () => api.countTunnels());
  } catch (error) {
    // A lost lease stops the request; a failed read falls back to the scan.
    if (error instanceof EndpointOperationError) throw error;
  }
  if (count === null) {
    const snapshot = (await allocation.snapshots()).get(account.accountId);
    if (snapshotFresh(snapshot, Date.now())) count = snapshot?.tunnel_count ?? null;
  }
  return count !== null && count >= account.tunnelLimit
    ? new EndpointOperationError("cf_tunnel_quota")
    : rateLimited;
}

/** The row's tunnel in its account: adopted by its stable name, or created. */
export async function acquireTunnel(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  account: EndpointAccount,
  allocation: Allocation,
): Promise<{ created: boolean; tunnelId: string }> {
  const tunnels = await withClaimLease(
    env,
    claim,
    () => api.listTunnels(claim.row.tunnel_name),
  );
  if (tunnels.length > 1) throw new EndpointOperationError("tunnel_name_conflict");
  const existing = tunnels[0];
  if (existing) {
    if (claim.row.tunnel_id && claim.row.tunnel_id !== existing.id) {
      throw new EndpointOperationError("tunnel_id_conflict");
    }
    return { created: false, tunnelId: existing.id };
  }
  try {
    const tunnel = await withClaimLease(
      env,
      claim,
      () => api.createTunnel(claim.row.tunnel_name),
    );
    return { created: true, tunnelId: tunnel.id };
  } catch (createError) {
    if (createError instanceof CloudflareAPIError && createError.code === "cf_rate_limited") {
      throw await classifyCreate429(env, claim, api, account, allocation, createError);
    }
    // A timeout can arrive after Cloudflare committed the POST: reconcile by the
    // stable name instead of creating a duplicate tunnel.
    let created: CloudflareTunnel[];
    try {
      created = await withClaimLease(
        env,
        claim,
        () => api.listTunnels(claim.row.tunnel_name),
      );
    } catch {
      throw createError;
    }
    if (created.length > 1) throw new EndpointOperationError("tunnel_name_conflict");
    const adopted = created[0];
    if (!adopted) throw createError;
    return { created: false, tunnelId: adopted.id };
  }
}

/** Returns false, leaving the row where it is, when its current account already
 * holds a tunnel or DNS record under its names: an interrupted earlier request
 * committed there, and the row adopts it. */
export async function relocateClaim(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  from: EndpointAccount,
  target: EndpointAccount,
  requestId: string,
): Promise<boolean> {
  if (!neverReady(claim.row) || target.accountId === from.accountId) return false;
  const tunnels = await withClaimLease(env, claim, () => api.listTunnels(claim.row.tunnel_name));
  if (tunnels.length > 0) return false;
  const records = await withClaimLease(env, claim, () => api.listDNSRecords(claim.row.hostname));
  if (records.length > 0) return false;

  const opaque = randomHex(16);
  const hostname = `c-${opaque}.${target.companionHostSuffix}`;
  const tunnelName = `hezuo-c-${opaque}`;
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET provider_account = ?, hostname = ?, tunnel_name = ?, updated_at = ?
      WHERE installation_id = ? AND generation = ? AND lease_owner = ?
        AND tunnel_id IS NULL AND dns_record_id IS NULL AND last_reconciled_at IS NULL`,
  ).bind(
    target.accountId,
    hostname,
    tunnelName,
    Date.now(),
    claim.row.installation_id,
    claim.row.generation,
    claim.leaseOwner,
  ).run();
  if (result.meta.changes === 0) throw new EndpointOperationError("lease_lost");
  claim.row.provider_account = target.accountId;
  claim.row.hostname = hostname;
  claim.row.tunnel_name = tunnelName;
  console.log(JSON.stringify({
    message: "managed endpoint relocated",
    requestId,
    from: from.companionHostSuffix,
    to: target.companionHostSuffix,
  }));
  return true;
}

/** Points the row's one DNS record at `tunnelId`: adopted, repaired, or
 * created. `held` records what it may roll back, also when it throws. */
export async function pointDNSRecord(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  tunnelId: string,
  held: HeldResources,
): Promise<void> {
  const target = expectedTunnelTarget(tunnelId);
  const records = await withClaimLease(
    env,
    claim,
    () => api.listDNSRecords(claim.row.hostname),
  );
  if (records.length > 1) throw new EndpointOperationError("dns_record_conflict");
  const existing = records[0];
  if (existing) {
    if (existing.content.toLowerCase() !== target && existing.id !== held.dnsRecordId) {
      throw new EndpointOperationError("dns_record_conflict");
    }
    held.dnsMayReferenceTunnel = existing.content.toLowerCase() === target;
    let record = existing;
    if (!existing.proxied || existing.content.toLowerCase() !== target) {
      held.dnsMayReferenceTunnel = true;
      try {
        record = await withClaimLease(
          env,
          claim,
          () => api.updateDNSRecord(existing.id, claim.row.hostname, tunnelId),
        );
      } catch (writeError) {
        try {
          const reconciled = await reconcileDNSWriteResult(
            env,
            claim,
            api,
            tunnelId,
            existing.id,
          );
          if (!reconciled) throw writeError;
          record = reconciled;
        } catch (reconcileError) {
          if (reconcileError instanceof EndpointOperationError) throw reconcileError;
          throw writeError;
        }
      }
    }
    held.dnsRecordId = record.id;
    return;
  }
  held.dnsMayReferenceTunnel = true;
  try {
    const record = await withClaimLease(
      env,
      claim,
      () => api.createDNSRecord(claim.row.hostname, tunnelId),
    );
    held.dnsRecordId = record.id;
    held.createdDNSRecord = true;
  } catch (writeError) {
    try {
      const reconciled = await reconcileDNSWriteResult(
        env,
        claim,
        api,
        tunnelId,
        null,
      );
      if (!reconciled) {
        held.dnsMayReferenceTunnel = false;
        throw writeError;
      }
      // The response did not prove this request created the record: adopt
      // and retain it instead of destructively guessing.
      held.dnsRecordId = reconciled.id;
    } catch (reconcileError) {
      if (reconcileError instanceof EndpointOperationError) throw reconcileError;
      throw writeError;
    }
  }
}
