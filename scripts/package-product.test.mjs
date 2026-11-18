import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseArgs, productBuildConfig, productOrigin, UsageError } from "./package-product.mjs";

const origin = (url, options) => productOrigin({ HEZUO_PRODUCT_SERVICE_URL: url }, options);

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scratchDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "hezuo-debug-packaging-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("the product package flags", () => {
  it("uses the canonical signed product identity without a publisher", async () => {
    const scratch = await scratchDirectory();
    const { config } = await productBuildConfig({ scratch, platform: "mac" });
    expect(config).toMatchObject({ appId: "com.hezuobot.app", productName: "HezuoBot", publish: null, dmg: { sign: true } });
    expect(config.mac.identity).not.toBe(null);
    expect(config.protocols[0].schemes).toEqual(["hezuobot"]);
  });

  it("enables debug logging only with an explicit build flag", () => {
    expect(parseArgs(["--platform", "mac"]).debug).toBe(false);
    expect(parseArgs(["--platform", "mac", "--debug"]).debug).toBe(true);
    expect(parseArgs(["--", "--platform", "mac", "--debug", "--help"])).toMatchObject({ debug: true, help: true });
  });

  it.each(["mac", "win"])("bundles the exact debug marker only for %s debug builds", async (platform) => {
    const scratch = await scratchDirectory();
    const markerPath = path.join(scratch, "product-debug.json");
    const { config } = await productBuildConfig({ scratch, platform, debug: true });
    expect(config.extraResources.filter((entry) => entry.to === "product-debug.json"))
      .toEqual([{ from: markerPath, to: "product-debug.json" }]);
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({ enabled: true });
  });

  it("removes a prior debug marker and resource mapping for a normal build", async () => {
    const scratch = await scratchDirectory();
    const markerPath = path.join(scratch, "product-debug.json");
    await productBuildConfig({ scratch, platform: "mac", debug: true });
    const { config } = await productBuildConfig({ scratch, platform: "mac" });
    expect(config.extraResources.some((entry) => entry.to === "product-debug.json")).toBe(false);
    await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("--lan-origin needs --gateway-ca, like --local-origin", () => {
    expect(() => parseArgs(["--platform", "mac", "--lan-origin"])).toThrow(/--lan-origin needs --gateway-ca/);
    expect(parseArgs(["--platform", "mac", "--lan-origin", "--gateway-ca", "gateway-cert.pem"])).toMatchObject({ lanOrigin: true, gatewayCa: "gateway-cert.pem" });
    expect(() => parseArgs(["--platform", "mac", "--local-origin"])).toThrow(/--local-origin needs --gateway-ca/);
  });

  it("takes a private-network IPv4 origin only with the flag", () => {
    expect(origin("https://192.168.66.193:18487", { lanOrigin: true })).toBe("https://192.168.66.193:18487");
    expect(() => origin("https://192.168.66.193:18487")).toThrow(UsageError);
    expect(() => origin("https://192.168.66.193:18487")).toThrow(/--lan-origin/);
  });

  it("refuses a public IP address even with the flag", () => {
    expect(() => origin("https://8.8.8.8:18487", { lanOrigin: true })).toThrow(/public DNS host/);
  });

  it("requires explicit approval for public DNS hosts and uses the default HTTPS port", () => {
    const publicOrigin = (url) => productOrigin({
      HEZUO_PRODUCT_SERVICE_URL: url,
      HEZUO_PRODUCT_SERVICE_ALLOWED_HOSTS: "ai.acme-ai.net",
    });
    expect(() => origin("https://ai.acme-ai.net")).toThrow(/HEZUO_PRODUCT_SERVICE_ALLOWED_HOSTS/);
    expect(publicOrigin("https://ai.acme-ai.net")).toBe("https://ai.acme-ai.net");
    expect(() => publicOrigin("https://ai.acme-ai.net:18487")).toThrow(/default HTTPS port/);
    expect(() => origin("https://127.0.0.1:18487", { lanOrigin: true })).toThrow(/loopback/);
  });
});
