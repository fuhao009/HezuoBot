import { createHash } from "node:crypto";
import { ControlPlaneError, normalizeAccountEmail } from "./control-plane-client.mjs";

const ACCOUNT_KEY = /^[0-9a-f]{64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const NETWORK_CODES = new Set([
  "network_unavailable",
  "control_plane_unavailable",
  "rate_limited",
  "internal_error",
  "request_failed",
  "invalid_response",
  "ai_unavailable",
]);

const boundedToken = (value) =>
  typeof value === "string" && value.length >= 20 && value.length <= 8_192 && /^\S+$/.test(value);

const boundedText = (value, maximum) =>
  typeof value === "string" && value.length >= 1 && value.length <= maximum;

/** sha256(origin + "\n" + user.id): main's workspace root and storage
 * partition, so two accounts on one computer never share either. */
export function productAccountKey(origin, userId) {
  if (!boundedText(origin, 512) || !boundedText(userId, 256)) {
    throw new Error("product_account_identity_invalid");
  }
  return createHash("sha256").update(`${origin}\n${userId}`).digest("hex");
}

export function productAccountPartition(accountKey) {
  if (!ACCOUNT_KEY.test(typeof accountKey === "string" ? accountKey : "")) {
    throw new Error("product_account_identity_invalid");
  }
  return `persist:product-${accountKey}`;
}

export function copyState(state) {
  const copy = { auth: state.auth, runtime: state.runtime };
  if (state.user) copy.user = { id: state.user.id, email: state.user.email };
  if (state.authMethods) {
    copy.authMethods = {
      password: { ...state.authMethods.password },
      emailCode: { ...state.authMethods.emailCode },
      emailVerification: state.authMethods.emailVerification,
    };
  }
  if (typeof state.pendingEmail === "string") copy.pendingEmail = state.pendingEmail;
  if (state.ai) {
    copy.ai = {
      state: state.ai.state,
      unit: "points",
      availableMicroPoints: state.ai.availableMicroPoints,
      reservedMicroPoints: state.ai.reservedMicroPoints,
      defaultModel: state.ai.defaultModel,
      models: state.ai.models.map((model) => ({ ...model })),
    };
  }
  if (state.errorCode) copy.errorCode = state.errorCode;
  return copy;
}

export const errorCodeOf = (error, fallback = "request_failed") => {
  const code = error instanceof ControlPlaneError ? error.code : "";
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : fallback;
};

export const isUnauthorized = (error) =>
  error?.status === 401 || errorCodeOf(error) === "unauthorized" || errorCodeOf(error) === "signed_out";

export function parseProductAccountRecord(value, serviceOrigin, recordVersion) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== recordVersion || value.origin !== serviceOrigin) return null;
  if (!boundedToken(value.accountToken)) return null;
  const savedUser = value.user;
  if (!savedUser || typeof savedUser !== "object" || Array.isArray(savedUser)) return null;
  const email = normalizeAccountEmail(savedUser.email);
  if (!email || email !== savedUser.email || !boundedText(savedUser.id, 256)) return null;
  if (typeof value.deviceId !== "string" || !UUID.test(value.deviceId)) return null;
  return { accountToken: value.accountToken, user: { id: savedUser.id, email }, deviceId: value.deviceId };
}
