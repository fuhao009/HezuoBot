import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { resolveGatewayConfig } from "./local-gateway/config.mjs";

it("uses the explicitly configured canonical data directory", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "hezuo-gateway-config-"));
  try {
    const config = resolveGatewayConfig({
      environment: { HEZUO_LOCAL_DATA_DIR: dataDir },
      options: { port: 8787 },
    });
    expect(config.dataDir).toBe(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
