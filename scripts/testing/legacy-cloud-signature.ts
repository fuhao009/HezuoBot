import { createHash, createHmac } from "node:crypto";

// Historical signed-request fixtures only; the production Cloud endpoints are removed.
export function cloudRequestSignature(secret: string, timestamp: string, nonce: string, method: string, target: string, body: Buffer | string): string {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`v1\n${timestamp}\n${nonce}\n${method}\n${target}\n${bodyHash}`).digest("base64url");
}

export function cloudPairingSignature(secret: string, timestamp: string, nonce: string, body: Buffer | string): string {
  return cloudRequestSignature(secret, timestamp, nonce, "POST", "/api/cloud/pairing", body);
}
