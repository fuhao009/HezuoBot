import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { OPENCODE_PROVIDER_ENV, PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV, stripWorkspaceCredentialEnv } from "./config.ts";
import { discoverOpenCodeModels, ensureOpenCodeInjectModel, resetOpenCodeModelCache } from "./drivers/acp/opencode-go.ts";
import { readClaudeAuthSettings, readClaudeModelCatalog } from "./drivers/claude.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratchDirs: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
};

afterEach(async () => {
  resetOpenCodeModelCache();
  for (const dir of scratchDirs.splice(0)) await removeTempDir(dir);
});

describe("Claude provider settings", () => {
  const settingsHome = (env: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const home = scratch("hezuo-provider-claude-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ ...extra, env }));
    return home;
  };
  const providerEnv = {
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    ANTHROPIC_AUTH_TOKEN: "sk-or-fake",
    ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_fake",
    ANTHROPIC_MODEL: "deepseek/deepseek-chat",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek/deepseek-reasoner",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek/deepseek-subagent",
  };

  it("carries provider credentials and headers from the settings env block", () => {
    const home = settingsHome(providerEnv);
    expect(readClaudeAuthSettings({ HOME: home }).env).toEqual({
      ANTHROPIC_BASE_URL: providerEnv.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: providerEnv.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_CUSTOM_HEADERS: providerEnv.ANTHROPIC_CUSTOM_HEADERS,
    });
  });

  it("lists custom provider models without carrying model settings into the auth environment", () => {
    const home = settingsHome(providerEnv, {
      modelPicker: { options: [{ model: "glm-latest[1m]", label: "GLM" }] },
    });
    const catalog = readClaudeModelCatalog({ HOME: home });
    const custom = catalog.options.filter((option) => option.custom).map((option) => option.id);
    expect(custom).toEqual([providerEnv.ANTHROPIC_MODEL, providerEnv.ANTHROPIC_DEFAULT_SONNET_MODEL]);
    expect(JSON.stringify(catalog)).not.toContain(providerEnv.CLAUDE_CODE_SUBAGENT_MODEL);
    expect(JSON.stringify(catalog)).not.toContain("glm-latest");
    const carried = Object.keys(readClaudeAuthSettings({ HOME: home }).env ?? {});
    expect(carried.filter((key) => /MODEL/u.test(key))).toEqual([]);
  });

  it("ignores provider settings when an Anthropic key is saved in Connections", () => {
    const home = settingsHome(providerEnv);
    expect(readClaudeAuthSettings({ HOME: home }, { ANTHROPIC_API_KEY: "connections-fake-key" })).toEqual({});
  });
});

describe("OpenCode provider configuration", () => {
  it("lists provider models and effort variants through ACP on OpenCode 2", async () => {
    const dir = scratch("hezuo-provider-opencode2-");
    const catalog = await discoverOpenCodeModels({
      ...process.env, HOME: dir, USERPROFILE: dir,
      XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"),
      FAKE_ACP_MODELS_LIST: "v2",
      FAKE_ACP_MODELS: "openrouter/deepseek/deepseek-chat,opencode/longcat-2.5-preview-free",
      FAKE_ACP_VARIANTS: JSON.stringify({ "openrouter/deepseek/deepseek-chat": { options: [{ value: "high", name: "High" }] } }),
    }, join(ROOT, "desktop", "server", "testing", "fake-acp-cli.ts"));
    expect(catalog.options.map((option) => option.id)).toEqual([
      "openrouter/deepseek/deepseek-chat", "opencode/longcat-2.5-preview-free",
    ]);
    expect(catalog.options.map((option) => option.variants)).toEqual([[{ id: "high", label: "High" }], undefined]);
  });

  const provider = {
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "https://router.example/v1", apiKey: "fake-provider-key" },
    models: { "provider-model": { name: "Provider model" } },
  };
  const configHome = (content: string) => {
    const home = scratch("hezuo-provider-opencode-json-");
    const dir = join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode.json"), content);
    return { home, path: join(dir, "opencode.json") };
  };
  const addLocalModel = (home: string) => ensureOpenCodeInjectModel("omlx::GLM-5.2-fp8", { HOME: home });

  it.each(["\n", "\r\n"])("preserves a configured provider when adding a local model with %j line endings", (lineEnding) => {
    const source = JSON.stringify({ provider: { myrouter: provider } }, null, 2).replace(/\n/gu, lineEnding);
    const { home, path } = configHome(source);
    expect(addLocalModel(home)).toBe("omlx/GLM-5.2-fp8");
    const after = JSON.parse(readFileSync(path, "utf8")) as { provider: Record<string, unknown> };
    expect(after.provider.myrouter).toEqual(provider);
    expect(after.provider.omlx).toBeTruthy();
  });

  it("replaces an unreadable commented config when adding a local model", () => {
    const source = JSON.stringify({ provider: { myrouter: provider } }, null, 2);
    const { home, path } = configHome(source.replace('"myrouter": {', '// my router\n    "myrouter": {'));
    addLocalModel(home);
    const after = JSON.parse(readFileSync(path, "utf8")) as { provider: Record<string, unknown> };
    expect(after.provider.myrouter).toBeUndefined();
    expect(after.provider.omlx).toBeTruthy();
  });
});

describe("exported provider credential scope", () => {
  it("leaves general provider keys in the inherited environment", () => {
    const exported = ["OPENROUTER_API_KEY", "FIREWORKS_API_KEY", "TOGETHER_API_KEY"];
    const filtered = new Set<string>([...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]);
    expect(exported.filter((name) => filtered.has(name))).toEqual([]);
    const env: Record<string, string | undefined> = Object.fromEntries(exported.map((name) => [name, "fake"]));
    stripWorkspaceCredentialEnv(env);
    expect(Object.keys(env).sort()).toEqual([...exported].sort());
  });

  it("scopes Cline credentials to Cline and OpenCode", () => {
    expect(PROVIDER_CREDENTIAL_ENV).toContain("CLINE_API_KEY");
    expect(OPENCODE_PROVIDER_ENV).toContain("CLINE_API_KEY");
  });
});
