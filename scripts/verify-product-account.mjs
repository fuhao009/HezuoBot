#!/usr/bin/env node
// The real app, the real Worker, the real gateway, in one disposable place.
//
//   node scripts/verify-product-account.mjs
//   node scripts/verify-product-account.mjs --app "/absolute/HezuoBot.app"
//   node scripts/verify-product-account.mjs --keep     (keep the disposable profile)
//   node scripts/verify-product-account.mjs --worker-project /path/to/gateway/control-plane
// The selected project supplies the Worker, migrations and pinned Wrangler runtime.
//
// Real here means:
//   * gateway/control-plane (this checkout unless --worker-project is explicit),
//     bundled with esbuild and run by its own Wrangler's Miniflare over TLS,
//     with a D1 database built from that project's migrations, the Worker's real EMAIL
//     binding (a disposable mailbox), and a real loopback upstream reached
//     through the Worker's own egress hook. Account sign-in, operator
//     enable/grant, model tokens, billing and the ledger are the production
//     Worker code; nothing fakes a status or injects a capability over HTTP.
//   * the desktop app itself: desktop/electron/main.mjs, its product auth gate, the
//     real account and workspace windows, its own server child, the product AI
//     provider, and a real stdio MCP server that writes one file.
//   * no personal key, engine CLI, Cloud account or operator secret is used.
//     The fixture's explicit test entry (HEZUO_PRODUCT_FIXTURE=1 plus a temp
//     root argument) is what lets a loopback HTTPS origin stand in for the
//     operator's own service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { electronBinary, packagedBinary, workerProjectPaths } from "./product-fixture/runtime.mjs";
import { fileURLToPath } from "node:url";
import { startWorkerFixture, trustFixtureCertificate, FIXTURE_CHARGE_MICRO_POINTS, MODELS } from "./product-fixture/worker-fixture.mjs";
import { signIn, signInWithPassword, operatorLookup, operatorSetAccount, operatorGrant } from "./product-fixture/operator.mjs";
import { attachPage, clickButtonByText, fillField, waitForPage } from "./product-fixture/cdp.mjs";
import { startPanelAbsenceObservation, checkpointPanelAbsence } from "./product-fixture/panel-absence-ui.mjs";
import { verifySignInCancellation } from "./product-fixture/sign-in-cancel-ui.mjs";
import {
  openAccountSettings, closeSettings, sendMessage, waitForText, waitSettled, workspaceApi,
  signOutWorkspace, signUpThroughPasswordGate, signInThroughPasswordGate, signInThroughGate,
  verifyNewBotAvatars,
} from "./product-fixture/account-ui.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ACCOUNT_A = "person-a@fixture.test";
const ACCOUNT_B = "person-b@fixture.test";
const PASSWORD = "fixture password 2026";

function parseCli() {
  const { values } = parseArgs({
    options: {
      app: { type: "string" },
      keep: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      port: { type: "string" },
      // Exercise the password form against a deployment with no mail transport:
      // sign-up needs no code, and every later sign-in is the password alone.
      password: { type: "boolean", default: false },
      "bundled-trust": { type: "boolean", default: false },
      "worker-project": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  return values;
}

/** A temp root whose canonical path keeps the gate's own basename rule; macOS's
 * /var → /private/var means the argument must be the real path. */
function fixtureRoot() {
  const created = mkdtempSync(join(tmpdir(), "hezuo-product-verify-"));
  const root = realpathSync(created);
  for (const name of ["home", "evidence", "bin"]) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  return root;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The app's environment: a disposable HOME, no engine/CLI on PATH, and no
 * account, key or operator secret inherited from this shell. TMPDIR is the
 * parent's own system temp, canonicalised exactly as main's fixture gate does,
 * so the app resolves the same temporary root this script created. */
function appEnvironment({ root, origin, certPath, verbose, socketDirectory }) {
  const environment = {};
  const keep = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ", "TERM", "USER"]);
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && keep.has(key)) environment[key] = value;
  environment.HOME = join(root, "home");
  environment.USERPROFILE = environment.HOME;
  environment.PATH = [join(root, "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
  const temporary = realpathSync(tmpdir());
  environment.TMPDIR = temporary;
  environment.TEMP = temporary;
  environment.TMP = temporary;
  environment.XDG_RUNTIME_DIR = socketDirectory;
  if (certPath) environment.NODE_EXTRA_CA_CERTS = certPath;
  environment.HEZUO_PRODUCT_FIXTURE = "1";
  environment.HEZUO_PRODUCT_FIXTURE_ORIGIN = origin;
  if (verbose) environment.ELECTRON_ENABLE_LOGGING = "1";
  return environment;
}

function launchApp({ appBinary, devBinary, root, origin, certPath, debugPort, verbose, socketDirectory }) {
  const common = [
    `--remote-debugging-port=${debugPort}`,
    "--remote-allow-origins=*",
    "--no-sandbox",
    "--lang=en-US",
    "--host-resolver-rules=MAP example.test 127.0.0.1",
    ...(process.platform === "linux" ? ["--disable-gpu"] : []),
    // The fixture's HOME is disposable, so there is no login keychain to unlock. Electron's own
    // mock keychain keeps `safeStorage` (and therefore the encrypted record store) real without
    // raising an OS permission prompt nobody is at the machine to answer.
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
  ];
  const args = appBinary ? [...common, `--hezuo-product-fixture-root=${root}`]
    : [...common, `--hezuo-product-fixture-root=${root}`, ROOT];
  const child = spawn(appBinary ?? devBinary, args, {
    env: appEnvironment({ root, origin, certPath, verbose, socketDirectory }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, logs: () => `${stdout}\n${stderr}`.trim().slice(-6_000) };
}

/** The same text the account pages render: points, six decimals, no currency. */
const points = microPoints => {
  const whole = Math.floor(microPoints / 1_000_000);
  return `${whole}.${String(microPoints - whole * 1_000_000).padStart(6, "0")}`;
};

const sleep = delay;

async function main() {
  const options = parseCli();
  if (options["bundled-trust"] && (!options.app || process.platform !== "darwin")) throw new Error("--bundled-trust requires a macOS --app bundle");
  const workerProject = workerProjectPaths(options["worker-project"]);
  let appBinary = options.app ? packagedBinary(options.app) : null;
  if (options.app && !appBinary) throw new Error(`no executable inside ${options.app}`);
  const devBinary = appBinary ? null : electronBinary();
  if (!appBinary && !devBinary) {
    throw new Error("no Electron binary: run `pnpm install` for this checkout, set ELECTRON_OVERRIDE_DIST_PATH/HEZUO_VERIFY_ELECTRON, or pass --app");
  }

  const root = fixtureRoot();
  const evidence = join(root, "evidence");
  const receipt = {
    startedAt: new Date().toISOString(),
    app: options.app ? "packaged" : "checkout",
    scope: { accountGateway: "real selected Worker project", modelUpstream: "synthetic loopback fixture", realModelAcceptance: false },
    workerProject,
    binary: appBinary ?? devBinary,
    origin: null,
    steps: [],
    screenshots: [],
    errors: [],
    accounts: {},
    balance: {},
    ledger: {},
    files: {},
    processes: {},
  };
  const record = (step, detail = {}) => receipt.steps.push({ step, at: Date.now(), ...detail });
  const capture = async (page, name) => {
    const file = join(evidence, `${name}.png`);
    writeFileSync(file, await page.screenshot());
    receipt.screenshots.push(file);
    return file;
  };
  /** The account bridge's own state, with no credential anywhere in it. */
  const accountSnapshot = async target => {
    if (!target) return null;
    return await target.evaluate(`window.hezuo?.productAccount?.state?.().then(state => ({
      auth: state.auth,
      runtime: state.runtime,
      ai: state.ai ? { state: state.ai.state, unit: state.ai.unit, availableMicroPoints: state.ai.availableMicroPoints, reservedMicroPoints: state.ai.reservedMicroPoints } : null,
      errorCode: state.errorCode ?? null,
      email: state.user?.email ?? null,
    }))`).catch(() => null);
  };

  let worker, app, page, gate, liveGate, socketDirectory;
  try {
    socketDirectory = mkdtempSync("/tmp/hb-");
    receipt.browserSocketDirectory = { path: socketDirectory, environmentKey: "XDG_RUNTIME_DIR", scope: "this fixture child only", cleaned: false };
    console.log("starting the real Worker (Miniflare + D1 + EMAIL + egress)…");
    worker = await startWorkerFixture({ root: join(root, "worker-run"), mail: !options.password, workerProject: workerProject.root,
      log: line => console.log(`  worker: ${line}`) });
    receipt.origin = worker.origin;
    trustFixtureCertificate(worker.certPath);
    if (options["bundled-trust"]) {
      const copy = join(root, "HezuoBot.app");
      cpSync(options.app, copy, { recursive: true, verbatimSymlinks: true });
      writeFileSync(join(copy, "Contents", "Resources", "product-service.json"), JSON.stringify({
        version: 2, origin: worker.origin, ca: readFileSync(worker.certPath, "utf8"),
      }));
      appBinary = packagedBinary(copy);
      receipt.binary = appBinary;
      receipt.bundledTrust = { enabled: true, environmentCa: false };
    }

    const debugPort = Number(options.port) || await freePort();
    console.log(`launching ${appBinary ?? devBinary} (debugger on 127.0.0.1:${debugPort})…`);
    app = launchApp({ appBinary, devBinary, root, origin: worker.origin, certPath: options["bundled-trust"] ? null : worker.certPath, debugPort, verbose: options.verbose, socketDirectory });

    // ---------- 1. The real account window: email → code → pending ----------
    const gateTarget = await waitForPage(debugPort, /\/product-account\.html/, { description: "account window" });
    gate = await attachPage(gateTarget);
    liveGate = gate;
    await gate.until("document.querySelector('[data-product-account-window]')", { label: "account window mounted" });
    assert.equal(await gate.evaluate("document.querySelector('[data-product-account-window]').dataset.productAccountWindow"), "sign-in");
    await capture(gate, "01-account-sign-in");

    if (options.password) {
      console.log(`creating ${ACCOUNT_A} through the password form (no mail transport)…`);
      await gate.click("Create an account", clickButtonByText("Create an account"));
      await gate.evaluate(fillField('input[type="email"]', ACCOUNT_A));
      await gate.evaluate(fillField('input[autocomplete="new-password"]', PASSWORD));
      await gate.evaluate(`(() => {
        const fields = document.querySelectorAll('input[autocomplete="new-password"]');
        const repeat = fields[1];
        if (!repeat) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(repeat, ${JSON.stringify(PASSWORD)});
        repeat.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`);
      await gate.click("Create an account", `(() => [...document.querySelectorAll('button[type=submit]')].find(button => !button.disabled))()`);
    } else {
      console.log(`signing in as ${ACCOUNT_A} with the Worker's own email code…`);
      // The gate offers password first; this deployment has mail, so the emailed
      // sign-in form is one button away and stays the fixture's way in.
      await gate.click("Email me a sign-in code", clickButtonByText("Email me a sign-in code"));
      await gate.evaluate(fillField('input[type="email"]', ACCOUNT_A));
      await gate.click("Send code", clickButtonByText("Send code"));
      const codeA = await worker.mail.nextCode();
      await gate.until("Boolean(document.querySelector('input[inputmode=\"numeric\"]'))", { label: "the code field" });
      await gate.evaluate(fillField('input[inputmode="numeric"]', codeA));
      await gate.click("Verify and sign in", `(() => [...document.querySelectorAll("button[type=submit]")].find(button => !button.disabled))()`);
    }
    try {
      await gate.until("document.querySelector('[data-product-account-window]')?.dataset.productAccountWindow === 'signed-in'", {
        label: "the account window becomes signed in", timeoutMs: 90_000,
      });
    } catch (error) {
      const state = await accountSnapshot(gate);
      throw new Error(`${error.message} (account state: ${JSON.stringify(state)})`);
    }
    record("signed in", { email: ACCOUNT_A, mailCount: worker.mail.count(), state: await accountSnapshot(gate) });

    // The workspace window replaces the gate; its own server child and provider load here.
    const workspaceTarget = await waitForPage(debugPort, /^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/, { description: "workspace window", timeoutMs: 120_000 });
    page = await attachPage(workspaceTarget);
    await page.until("Boolean(window.hezuo?.productAccount)", { label: "workspace product bridge", timeoutMs: 120_000 });
    await page.until("document.querySelector('[data-sidebar-product-account]')", { label: "the product sidebar", timeoutMs: 120_000 });
    await page.until(`document.querySelector('[data-sidebar-product-email]')?.textContent?.trim() === ${JSON.stringify(ACCOUNT_A)}`, { label: "the signed-in email in the sidebar" });
    assert.equal(await page.evaluate("document.querySelector('[data-sidebar-product-email]').textContent.trim()"), ACCOUNT_A);
    assert.equal(await page.evaluate("Boolean(window.hezuo.productAccount?.state)"), true, "the account bridge is the one main installed");
    receipt.workspaceUrl = workspaceTarget.url;
    receipt.accounts.a = { email: ACCOUNT_A };

    // Pending is the real status the Worker publishes for a never-enabled account.
    await openAccountSettings(page);
    await page.until("Boolean(document.querySelector('[data-product-account]'))", { label: "the account settings page" });
    // The account's own bridge reports the Worker's status; the page shows the same words.
    const pendingState = await page.untilValue("window.hezuo.productAccount.state().then(state => state.ai ? state : null)", {
      label: "the Worker's pending status", timeoutMs: 60_000,
    });
    assert.equal(pendingState.ai.state, "pending", `new account status was ${pendingState.ai.state}`);
    const pendingNotice = await page.evaluate("document.querySelector('[data-product-account]')?.textContent ?? ''");
    assert.match(pendingNotice, /Waiting for administrator activation|waiting for.*administrator|等待管理员开通/i, `pending notice was ${JSON.stringify(pendingNotice)}`);
    assert.equal(await page.evaluate("document.querySelector('[data-product-balance]').textContent.trim()"), "0.000000");
    assert.match(await page.evaluate("document.querySelector('[data-product-ledger]')?.textContent ?? ''"), /No account activity yet|account history|暂无账户记录/i);
    await capture(page, "02-workspace-pending");
    record("pending status", { notice: pendingNotice, state: await accountSnapshot(page) });

    // ---------- 2. The operator's real bootstrap: whoami → operator id → restart ----------
    console.log("operator bootstrap through the real control plane…");
    const operatorSession = options.password
      ? await signInWithPassword(worker.origin, ACCOUNT_A, PASSWORD)
      : await signIn(worker.origin, ACCOUNT_A, worker.mail);
    const operatorId = operatorSession.user.id;
    await worker.restart([operatorId], { mail: !options.password });
    receipt.operator = { id: operatorId, email: operatorSession.user.email };
    record("operator bootstrap", { id: operatorId });

    // Enable and grant through /v1/operator/ai/*: the same calls the CLI makes.
    const enabled = await operatorSetAccount(operatorSession.client, operatorSession.token, {
      userId: operatorId, enabled: true, reason: "fixture verification enable",
    });
    assert.equal(enabled.account.enabled, true);
    assert.equal(enabled.account.state, "insufficient_balance", "enabled without funds is its own state");
    const granted = await operatorGrant(operatorSession.client, operatorSession.token, {
      userId: operatorId, amountMicroPoints: 1_000_000, reason: "fixture verification grant",
    });
    assert.equal(granted.account.availableMicroPoints, 1_000_000);
    record("operator enable and grant", { availableMicroPoints: granted.account.availableMicroPoints });


    // ---------- 3. Refresh in the app; the account becomes ready ----------
    await page.click("Refresh", clickButtonByText("Refresh"));
    const readyState = await page.untilValue("window.hezuo.productAccount.state().then(state => state.ai?.state === 'ready' ? state : null)", {
      label: "the account becomes ready", timeoutMs: 90_000,
    });
    assert.equal(readyState.runtime, "ready", `runtime after readiness was ${readyState.runtime}`);
    // The account's own unit is points, from the gateway through the bridge: no currency ever reaches the page.
    assert.equal(readyState.ai.unit, "points", `the published unit (${JSON.stringify(readyState.ai)})`);
    await page.until("document.querySelector('[data-product-account]')?.textContent?.match(/Your account is ready/i)", {
      label: "the ready notice", timeoutMs: 30_000,
    });
    const readyBalance = await page.evaluate("document.querySelector('[data-product-balance]').textContent.trim()");
    assert.equal(readyBalance, points(1_000_000));
    const modelSurface = await page.evaluate("document.querySelector('[data-product-account]')?.textContent ?? ''");
    assert.ok(!modelSurface.includes(MODELS[0].label) && !modelSurface.includes(MODELS[0].id), "account page must not disclose execution models");
    await capture(page, "03-account-ready");
    record("ready status", { balance: readyBalance, state: await accountSnapshot(page) });
    assert.equal(await page.evaluate("window.hezuo.computerUsePolicy.get()"), "ask");
    await page.evaluate("document.querySelector('[data-settings-page=computer], [data-settings-section=computer]').click()");
    await page.until("Boolean(document.querySelector('select[aria-label=\"Execute on this computer\"]:not(:disabled)'))", { label: "computer permission control" });
    await page.evaluate(`(() => {
      const select = document.querySelector('select[aria-label="Execute on this computer"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "allow");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await page.until("document.querySelector('select[aria-label=\"Execute on this computer\"]')?.value === 'allow' && !document.querySelector('select[aria-label=\"Execute on this computer\"]')?.disabled", { label: "saved computer permission" });
    assert.equal(await page.evaluate("window.hezuo.computerUsePolicy.get()"), "allow");
    await capture(page, "03-computer-permission-allow");
    await page.evaluate("document.querySelector('[data-settings-page=botAccess], [data-settings-section=botAccess]').click()");
    await page.until("[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Configure permissions')", { label: "per-bot permission settings" });
    await capture(page, "03-permissions-settings");
    await openAccountSettings(page);
    record("persistent computer permission", { policy: "allow" });

    // The workspace model catalog must be the account's, and the default bot is there.
    await closeSettings(page);
    await page.until("document.querySelectorAll('[data-sidebar-bot-row]').length > 0", { label: "the default Hezuo", timeoutMs: 90_000 });
    await page.until("Boolean(document.querySelector('textarea[aria-label]'))", { label: "the composer" });
    assert.equal(await page.evaluate("document.querySelectorAll('[data-tour=model], [data-testid=model-badge]').length"), 0, "managed chat has no model picker or provider badge");
    const botId = await page.evaluate(`(() => {
      const row = document.querySelector('[data-sidebar-bot-row]');
      return row?.getAttribute('data-sidebar-bot-row') ?? '';
    })()`);
    assert.ok(botId, "the default bot's id");
    receipt.botId = botId;

    // ---------- 4. One hello, billed by the gateway ----------
    const statusBefore = await operatorSession.client.aiStatus(operatorSession.token);
    assert.equal(statusBefore.state, "ready");
    console.log("sending 你好 through the real gateway…");
    await sendMessage(page, "你好");
    await waitForText(page, "Hello from your account.");
    await waitSettled(page);
    const statusAfter = await operatorSession.client.aiStatus(operatorSession.token);
    const helloLedger = await operatorSession.client.aiLedger(operatorSession.token);
    const requests = helloLedger.items.filter(item => item.kind === "request");
    assert.ok(requests.length >= 1, `at least one metered request (${JSON.stringify(requests)})`);
    // The person's own reply is one request at the fixture's exact price; any helper the app runs for itself
    // (a title, for instance) is a separate, separately billed request, never a free side channel.
    const helloRequest = requests.find(item => item.inputTokens === 12 && item.cachedInputTokens === 2 && item.outputTokens === 3);
    assert.ok(helloRequest, `the hello's own request (${JSON.stringify(requests)})`);
    assert.equal(helloRequest.chargedMicroPoints, FIXTURE_CHARGE_MICRO_POINTS, `exact billed amount (${JSON.stringify(helloRequest)})`);
    assert.ok(requests.every(item => item.state === "settled"), "no request is left unreviewed or reserved");
    const totalCharged = requests.reduce((sum, item) => sum + (item.chargedMicroPoints ?? 0), 0);
    assert.equal(statusAfter.availableMicroPoints, statusBefore.availableMicroPoints - totalCharged);
    assert.equal(statusAfter.reservedMicroPoints, 0);
    assert.equal(statusAfter.state, "ready");
    receipt.balance.hello = { before: statusBefore.availableMicroPoints, after: statusAfter.availableMicroPoints, chargedMicroPoints: totalCharged, requestCount: requests.length };
    receipt.ledger.hello = requests;
    receipt.upstream = worker.upstream.state.calls.slice();
    await capture(page, "04-chat-hello");
    record("hello billed", { chargedMicroPoints: helloRequest.chargedMicroPoints, requestCount: requests.length });

    // R01: restart the actual app process, keeping only this disposable profile and Worker.
    // macOS uses Electron's mock keychain here; this does not verify the user's OS keychain.
    const restart = receipt.accountRestart = {
      startedAtMs: Date.now(), finishedAtMs: null, durationMs: null, passed: false,
      credentialStorage: process.platform === "darwin" ? "electron-mock-keychain" : "isolated-platform-storage",
      realOsKeychainVerified: false, previousPid: app.child.pid,
    };
    record("account restart started", { startedAtMs: restart.startedAtMs });
    try {
      await waitSettled(page);
      const idleSnapshot = `(async () => {
        const response = await fetch('/api/bots');
        if (!response.ok) throw new Error('workspace snapshot HTTP ' + response.status);
        const snapshot = await response.json();
        if (snapshot.bots.some(bot => bot.busy) || snapshot.groups.some(group => group.working)) return null;
        return snapshot.bots.find(bot => bot.id === ${JSON.stringify(botId)}) ?? null;
      })()`;
      const beforeRestart = await page.untilValue(idleSnapshot, { label: "idle workspace before app restart", timeoutMs: 120_000 });
      const helloMessages = beforeRestart.messages.filter(message => message.text === "你好" || message.text === "Hello from your account.");
      assert.ok(helloMessages.some(message => message.role === "user" && message.text === "你好"), "saved hello user message");
      assert.ok(helloMessages.some(message => message.role === "bot" && message.text === "Hello from your account."), "saved hello bot message");
      restart.threadId = beforeRestart.threadId;
      restart.messageIds = helloMessages.map(message => message.id);
      restart.before = await accountSnapshot(page);
      await capture(page, "04-restart-before");
      app.child.kill("SIGTERM");
      const stopped = await Promise.race([app.exited, sleep(15_000).then(() => null)]);
      assert.ok(stopped, "app must exit normally before restarting; forced termination is not a pass");
      assert.equal(stopped.code, 0, `normal app exit (${JSON.stringify(stopped)})`);
      restart.exit = stopped;
      restart.previousAppLogTail = app.logs();
      page.close(); gate?.close();
      page = null; gate = null; liveGate = null;
      app = launchApp({ appBinary, devBinary, root, origin: worker.origin, certPath: options["bundled-trust"] ? null : worker.certPath, debugPort, verbose: options.verbose, socketDirectory });
      restart.reopenedPid = app.child.pid;
      assert.notEqual(restart.reopenedPid, restart.previousPid, "a new app process was launched");
      const reopenedTarget = await waitForPage(debugPort, /^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/, { description: "workspace restored after app restart", timeoutMs: 120_000 });
      page = await attachPage(reopenedTarget);
      await page.until(`window.hezuo?.productAccount?.state().then(state => state.auth === 'signed_in' && state.runtime === 'ready' && state.user?.email === ${JSON.stringify(ACCOUNT_A)})`, {
        label: "same account restored without signing in", timeoutMs: 120_000,
      });
      await page.until(`document.querySelector('[data-sidebar-product-email]')?.textContent?.trim() === ${JSON.stringify(ACCOUNT_A)}`, { label: "restored account sidebar" });
      await waitForText(page, "你好");
      await waitForText(page, "Hello from your account.");
      await waitSettled(page);
      const afterRestart = await page.untilValue(idleSnapshot, { label: "restored idle conversation", timeoutMs: 120_000 });
      assert.equal(afterRestart.threadId, restart.threadId, "restart restores the original thread");
      for (const expected of helloMessages) {
        assert.ok(afterRestart.messages.some(message => message.id === expected.id && message.role === expected.role && message.text === expected.text), `restart restores original message ${expected.id}`);
      }
      restart.after = await accountSnapshot(page);
      await capture(page, "04-restart-restored");
      restart.passed = true;
    } finally {
      restart.finishedAtMs = Date.now();
      restart.durationMs = restart.finishedAtMs - restart.startedAtMs;
      record("account restart finished", { ...restart });
    }
    await startPanelAbsenceObservation(page, receipt);
    await checkpointPanelAbsence(page, receipt, "restored account chat");
    // ---------- 5. Real MCP write, approval required ----------
    console.log("adding the fixture MCP server and asking for a file write…");
    const allowedArtifact = join(root, "allowed-artifact.txt");
    const startedMarker = join(root, "mcp-started.txt");
    const mcpScript = join(ROOT, "scripts", "product-fixture", "mcp-write-server.mjs");
    await workspaceApi(page, "POST", "/api/mcp/servers", {
      name: "fixture-writer", command: process.execPath, args: [mcpScript],
      env: { FIXTURE_MCP_ARTIFACT: allowedArtifact, FIXTURE_MCP_STARTED: startedMarker }, enabled: true,
    });
    // A new server is saved off until it answers; the person turns it on, as in Settings.
    await workspaceApi(page, "PATCH", "/api/mcp/servers/fixture-writer", { enabled: true });
    await workspaceApi(page, "PATCH", `/api/bots/${botId}`, { mcpServers: ["fixture-writer"], approvalMode: "ask" });
    worker.upstream.state.scenario = "tool";
    await sendMessage(page, "Write the verification artifact with the file tool.");
    await page.until("Boolean([...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Allow once'))", { label: "the approval card", timeoutMs: 120_000 });
    assert.equal(existsSync(allowedArtifact), false, "no file exists before approval");
    assert.equal(existsSync(startedMarker), true, "the MCP server really started");
    await capture(page, "05-approval-pending");
    await checkpointPanelAbsence(page, receipt, "real MCP write approval pending");
    record("approval pending", { artifactExists: false });

    await page.click("Allow once", clickButtonByText("Allow once"));
    await waitForText(page, "The file is written.");
    await waitSettled(page);
    assert.equal(existsSync(allowedArtifact), true, "the tool wrote its file");
    assert.equal(readFileSync(allowedArtifact, "utf8"), "verified");
    receipt.files.allowed = { path: allowedArtifact, content: readFileSync(allowedArtifact, "utf8") };
    await capture(page, "06-chat-tool-allowed");
    await checkpointPanelAbsence(page, receipt, "real MCP write completed");
    record("tool allowed", { artifact: "verified" });

    // ---------- 6. Denial writes nothing ----------
    console.log("denying the same tool…");
    const deniedArtifact = join(root, "denied-artifact.txt");
    const deniedMarker = join(root, "mcp-denied-started.txt");
    await workspaceApi(page, "POST", "/api/mcp/servers", {
      name: "fixture-denier", command: process.execPath, args: [mcpScript],
      env: { FIXTURE_MCP_ARTIFACT: deniedArtifact, FIXTURE_MCP_STARTED: deniedMarker }, enabled: true,
    });
    await workspaceApi(page, "PATCH", "/api/mcp/servers/fixture-denier", { enabled: true });
    await workspaceApi(page, "PATCH", `/api/bots/${botId}`, { mcpServers: ["fixture-denier"], approvalMode: "ask" });
    worker.upstream.state.scenario = "deny";
    await sendMessage(page, "Write the verification artifact again.");
    await page.until("Boolean([...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Allow once'))", { label: "the second approval card", timeoutMs: 120_000 });
    assert.equal(existsSync(deniedArtifact), false);
    await page.click("Deny", clickButtonByText("Deny"));
    await waitForText(page, "The write was denied.");
    await waitSettled(page);
    await checkpointPanelAbsence(page, receipt, "real MCP write denied");
    assert.equal(existsSync(deniedArtifact), false, "a denied call writes nothing");
    receipt.files.denied = { path: deniedArtifact, exists: false };
    await capture(page, "07-chat-tool-denied");
    record("tool denied", { artifactExists: false });
    await verifySignInCancellation({ page, worker, botId, receipt, capture });

    // Every tool round is separate metered requests, not one chat charge.
    const toolLedger = await operatorSession.client.aiLedger(operatorSession.token);
    const metered = toolLedger.items.filter(item => item.kind === "request");
    assert.ok(metered.length >= 5, `each model request is billed separately (got ${metered.length})`);
    assert.ok(metered.every(item => item.state === "settled"));
    receipt.ledger.tool = metered.map(item => ({ id: item.id, state: item.state, chargedMicroPoints: item.chargedMicroPoints, model: item.model }));
    receipt.upstreamCalls = worker.upstream.state.calls.slice();
    record("separate metering", { requests: metered.length });

    // ---------- 7. The account page shows the gateway's own numbers ----------
    await openAccountSettings(page);
    await page.until("Boolean(document.querySelector('[data-product-ledger-entry]'))", { label: "ledger rows", timeoutMs: 60_000 });
    // The page's own Refresh re-reads the gateway; then the shown figures are the gateway's latest.
    await page.click("Refresh", clickButtonByText("Refresh"));
    await page.untilValue("window.hezuo.productAccount.state().then(state => state.ai ? state : null)", { label: "the refreshed account status" });
    const current = await operatorSession.client.aiStatus(operatorSession.token);
    await page.untilValue(`window.hezuo.productAccount.state().then(state => Math.abs((state.ai?.availableMicroPoints ?? -1) - ${current.availableMicroPoints}) <= 0)`, {
      label: "the page's balance equals the gateway's",
    });
    const shownBalance = await page.evaluate("document.querySelector('[data-product-balance]').textContent.trim()");
    const shownReserved = await page.evaluate("document.querySelector('[data-product-reserved]').textContent.trim()");
    assert.equal(shownBalance, points(current.availableMicroPoints));
    assert.equal(shownReserved, points(current.reservedMicroPoints));
    assert.equal(await page.evaluate("document.querySelectorAll('[data-product-ledger-review]').length"), 0, "no request is awaiting review");
    receipt.balance.final = { availableMicroPoints: current.availableMicroPoints, reservedMicroPoints: current.reservedMicroPoints };
    await capture(page, "08-account-ledger");
    record("account page", { balance: shownBalance, reserved: shownReserved });

    // ---------- 8. Sign out, account B: separate workspace, insufficient balance ----------
    console.log("signing out and signing in as a second account…");
    await signOutWorkspace(page);
    const gateTargetAfterA = await waitForPage(debugPort, /\/product-account\.html/, { description: "the account window after sign-out", timeoutMs: 120_000 });
    const gateAfterA = await attachPage(gateTargetAfterA);
    liveGate = gateAfterA;
    await gateAfterA.until("document.querySelector('[data-product-account-window]')?.dataset.productAccountWindow === 'sign-in'", {
      label: "the gate after A", timeoutMs: 120_000,
    });
    await capture(gateAfterA, "09-signed-out");

    const openB = options.password
      ? await signUpThroughPasswordGate(gateAfterA, ACCOUNT_B, PASSWORD)
      : await signInThroughGate(gateAfterA, ACCOUNT_B, worker.mail);
    assert.equal(openB.workspace, true);
    const pageB = openB.page;
    await pageB.until("document.querySelector('[data-sidebar-product-email]')?.textContent?.trim()", { label: "B's sidebar" });
    assert.equal(await pageB.evaluate("document.querySelector('[data-sidebar-product-email]').textContent.trim()"), ACCOUNT_B);
    const bodyB = await pageB.evaluate("document.body.innerText");
    assert.equal(bodyB.includes("Hello from your account."), false, "B must not see A's transcript");
    // B is registered by signing in; the operator then enables it without funding, so the real
    // insufficient-balance state (no personal key, no SQL) is what B's own page shows.
    const lookupB = await operatorLookup(operatorSession.client, operatorSession.token, ACCOUNT_B);
    if (!lookupB) throw new Error("the operator lookup did not find the second fixture account");
    const enabledB = await operatorSetAccount(operatorSession.client, operatorSession.token, {
      userId: lookupB.account.userId, enabled: true, reason: "fixture verification enable without funds",
    });
    assert.equal(enabledB.account.state, "insufficient_balance", "enabled without funds is insufficient_balance");
    await openAccountSettings(pageB);
    await pageB.click("Refresh", clickButtonByText("Refresh"));
    await pageB.untilValue("window.hezuo.productAccount.state().then(state => state.ai?.state === 'insufficient_balance' ? state : null)", {
      label: "B's insufficient-balance status", timeoutMs: 90_000,
    });
    const noticeB = await pageB.evaluate("document.querySelector('[data-product-account]').textContent.trim()");
    assert.equal(await pageB.evaluate("document.querySelector('[data-product-balance]').textContent.trim()"), "0.000000");
    assert.equal(await pageB.evaluate("window.hezuo.computerUsePolicy.get()"), "ask", "B must not inherit A's computer permission");
    assert.equal((await pageB.evaluate("window.hezuo.productAccount.operatorStatus()")).eligible, false);
    assert.equal((await pageB.evaluate("window.hezuo.productAccount.grantMaximum()")).outcome, "failed");
    await capture(pageB, "10-account-b-insufficient");
    receipt.accounts.b = { email: ACCOUNT_B, notice: noticeB, seesA: false };
    await closeSettings(pageB);

    // A turn must be refused before any upstream call.
    const callsBeforeRefusal = worker.upstream.state.calls.length;
    await pageB.until("Boolean(document.querySelector('textarea[aria-label]'))", { label: "B's composer" });
    await sendMessage(pageB, "你好");
    await pageB.until("Boolean(document.querySelector('[role=alert]'))", {
      label: "the balance refusal", timeoutMs: 120_000,
    });
    const refusal = await pageB.evaluate("(document.querySelector('[role=alert]')?.textContent ?? document.body.innerText).slice(0, 600)");
    assert.equal(worker.upstream.state.calls.length, callsBeforeRefusal, "no upstream call for an unfunded account");
    receipt.balance.insufficient = { notice: noticeB, refusal, upstreamCalls: worker.upstream.state.calls.length };
    await capture(pageB, "11-chat-insufficient");
    record("insufficient balance", { refusal });

    // ---------- 9. Back to A: its own history returns ----------
    await signOutWorkspace(pageB);
    const gateAgain = await waitForPage(debugPort, /\/product-account\.html/, { description: "the gate after B", timeoutMs: 120_000 });
    const gatePage = await attachPage(gateAgain);
    liveGate = gatePage;
    await gatePage.until("document.querySelector('[data-product-account-window]')?.dataset.productAccountWindow === 'sign-in'", {
      label: "the gate after B", timeoutMs: 120_000,
    });
    const backA = options.password
      ? await signInThroughPasswordGate(gatePage, ACCOUNT_A, PASSWORD)
      : await signInThroughGate(gatePage, ACCOUNT_A, worker.mail);
    const pageA = backA.page;
    await pageA.until("document.querySelector('[data-sidebar-product-email]')?.textContent?.trim()", { label: "A's sidebar again" });
    assert.equal(await pageA.evaluate("document.querySelector('[data-sidebar-product-email]').textContent.trim()"), ACCOUNT_A);
    await pageA.until("document.body.innerText.includes('Hello from your account.')", { label: "A's own history", timeoutMs: 90_000 });
    assert.equal(await pageA.evaluate("window.hezuo.computerUsePolicy.get()"), "allow", "A's permission persists across workspace restart");
    receipt.accounts.aRestored = true;
    await capture(pageA, "12-account-a-returned");
    record("account switch", { isolated: true, restored: true });
    // ---------- C. Simple creation UI, isolated from the default-bot assertions ----------
    // The loopback model cannot establish adherence to standing instructions. This
    // acceptance covers renderer controls and persistence only; it sends no turn.
    {
      const selectors = {
        newMenu: '[data-sidebar] button[aria-label="New or share"]',
        dialog: '[role="dialog"][aria-label="New Bot"]',
        name: '[data-new-bot-name]', prompt: '[data-new-bot-soul]',
        create: '[data-new-bot-create]', warning: '#new-bot-soul-limit[role="alert"]',
      };
      const c = receipt.simpleNewBot = {
        selectors, passed: false, promptAdherenceVerified: false,
        scope: "Renderer creation and persisted profile/SOUL only; synthetic model cannot prove prompt adherence",
      };
      const snapshot = () => pageA.evaluate(`fetch('/api/bots').then(response => {
        if (!response.ok) throw new Error('bot snapshot HTTP ' + response.status);
        return response.json();
      }).then(snapshot => snapshot.bots)`);
      const before = await snapshot();
      const originalId = await pageA.evaluate(`document.querySelector('[data-sidebar-bot-row][aria-current="page"]')?.getAttribute('data-sidebar-bot-row')`);
      assert.ok(originalId, "C: original selected bot is identifiable before creation");
      c.originalBotId = originalId;
      const accountRoot = join(root, "user-data", "product-accounts");
      const profileFiles = readdirSync(accountRoot).map(key => join(accountRoot, key, "workspace", "bots.json"));
      const profileFile = profileFiles.find(file => existsSync(file) && JSON.parse(readFileSync(file, "utf8")).some(bot => bot.id === originalId));
      assert.ok(profileFile, "C: selected account's persisted profile exists");
      const profileBeforeCancel = readFileSync(profileFile, "utf8");
      const openNewBot = async () => {
        await pageA.click("C: open New or share", `document.querySelector(${JSON.stringify(selectors.newMenu)})`);
        await pageA.click("C: choose New Bot", `(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(node => /^New bot$/i.test(node.textContent.trim())))()`);
        await pageA.until(`Boolean(document.querySelector(${JSON.stringify(selectors.dialog)})?.querySelector('[data-new-bot-name]'))`, { label: "C: simple creation draft", timeoutMs: 15_000 });
      };
      const cancel = () => pageA.click("C: Cancel", clickButtonByText("Cancel", `document.querySelector(${JSON.stringify(selectors.dialog)})`));
      try {
        await openNewBot();
        const controls = await pageA.evaluate(`(() => {
          const dialog = document.querySelector(${JSON.stringify(selectors.dialog)});
          return {
            fields: [...dialog.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="combobox"]')].map(node =>
              node.matches('[data-new-bot-name]') ? 'name' : node.matches('[data-new-bot-soul]') ? 'prompt' : node.matches('input[type="file"][accept^="image/"]') ? 'avatar' : 'unexpected'),
            actions: [...dialog.querySelectorAll(':scope > div:last-child button')].map(node => node.textContent.trim()),
            extraNavigation: dialog.querySelectorAll('[role="tab"], [role="tablist"], a, [role="menuitem"]').length,
          };
        })()`);
        assert.deepEqual(controls.fields.sort(), ["avatar", "name", "prompt"], "C: only avatar/name/prompt inputs");
        assert.deepEqual(controls.actions, ["Cancel", "Create bot"], "C: only Cancel/Create footer actions");
        assert.equal(controls.extraNavigation, 0, "C: no advanced navigation in simple dialog");
        c.controls = controls;
        await capture(pageA, "12c-new-bot-controls");
        assert.equal(await pageA.evaluate(fillField(selectors.name, "Cancelled fixture bot")), true);
        assert.equal(await pageA.evaluate(fillField(selectors.prompt, "This draft must never be saved.")), true);
        await cancel();
        await pageA.until(`!document.querySelector(${JSON.stringify(selectors.dialog)})`, { label: "C: cancelled dialog closes", timeoutMs: 15_000 });
        assert.deepEqual(await snapshot(), before, "C: cancel causes no bot mutation");
        assert.equal(readFileSync(profileFile, "utf8"), profileBeforeCancel, "C: cancel leaves persisted profiles unchanged");
        c.cancelUnchanged = true;
        await openNewBot();
        assert.equal(await pageA.evaluate(fillField(selectors.name, "")), true);
        await pageA.until("document.querySelector('[data-new-bot-create]')?.disabled", { label: "C: empty name disables Create", timeoutMs: 15_000 });
        await capture(pageA, "12c-new-bot-empty-name");
        const name = "C acceptance custom bot";
        const prompt = "You are the C acceptance assistant. Answer in short, clear Chinese sentences.";
        const oversizedPrompt = "界".repeat(8001); // 24,003 UTF-8 bytes, not merely characters.
        assert.ok(Buffer.byteLength(oversizedPrompt, "utf8") > 24_000);
        assert.equal(await pageA.evaluate(fillField(selectors.name, name)), true);
        assert.equal(await pageA.evaluate(fillField(selectors.prompt, oversizedPrompt)), true);
        await pageA.until("document.querySelector('[data-new-bot-create]')?.disabled && document.querySelector('[data-new-bot-soul]')?.getAttribute('aria-invalid') === 'true' && Boolean(document.querySelector('#new-bot-soul-limit[role=alert]')?.textContent.trim())", { label: "C: UTF-8 overflow disables Create with warning", timeoutMs: 15_000 });
        c.overflow = { bytes: Buffer.byteLength(oversizedPrompt, "utf8"), warning: await pageA.evaluate("document.querySelector('#new-bot-soul-limit').textContent.trim()") };
        await capture(pageA, "12c-new-bot-prompt-overflow");
        assert.equal(await pageA.evaluate(fillField(selectors.prompt, prompt)), true);
        await pageA.until("document.querySelector('[data-new-bot-create]')?.disabled === false && !document.querySelector('#new-bot-soul-limit[role=alert]')", { label: "C: valid draft enables Create and clears warning", timeoutMs: 15_000 });
        await capture(pageA, "12c-new-bot-valid");
        await pageA.click("C: Create", "document.querySelector('[data-new-bot-create]')");
        await pageA.until(`!document.querySelector(${JSON.stringify(selectors.dialog)})`, { label: "C: creation completes", timeoutMs: 30_000 });
        const after = await snapshot();
        const added = after.filter(bot => !before.some(previous => previous.id === bot.id));
        assert.equal(after.length, before.length + 1, "C: exactly one bot created");
        assert.equal(added.length, 1, "C: a new bot identity was created");
        const created = added[0];
        assert.equal(created.name, name, "C: custom name round-trips through workspace API");
        assert.equal(created.soul, prompt, "C: custom prompt round-trips through workspace API");
        const saved = JSON.parse(readFileSync(profileFile, "utf8")).find(bot => bot.id === created.id);
        assert.equal(saved?.name, name, "C: custom name persisted in profile");
        assert.equal(saved?.soul, prompt, "C: custom prompt persisted in profile");
        const soulFile = join(profileFile, "..", "bots", created.id, "SOUL.md");
        assert.equal(readFileSync(soulFile, "utf8"), prompt, "C: SOUL.md contains exact custom prompt");
        await pageA.until(`Boolean(document.querySelector('[data-sidebar-bot-row="${created.id}"]'))`, { label: "C: created bot in sidebar", timeoutMs: 15_000 });
        await capture(pageA, "12c-new-bot-created");
        c.created = { id: created.id, name, prompt, profileFile, soulFile };
        c.avatarCreation = {};
        await verifyNewBotAvatars({ page: pageA, openNewBot, snapshot, profileFile, root, capture, evidence: c.avatarCreation });
        c.passed = true;
      } finally {
        if (await pageA.evaluate(`Boolean(document.querySelector(${JSON.stringify(selectors.dialog)}))`)) await cancel();
        await pageA.click("C: restore original selected bot", `document.querySelector(${JSON.stringify(`[data-sidebar-bot-row="${originalId}"]`)})`);
        await pageA.until(`Boolean(document.querySelector(${JSON.stringify(`[data-sidebar-bot-row="${originalId}"][aria-current="page"]`)})) && Boolean(document.querySelector('[data-product-chat] textarea'))`, { label: "C: original selected bot restored", timeoutMs: 15_000 });
        c.originalSelectionRestored = true;
      }
      record("C simple new bot UI acceptance", c);
    }


    // ---------- 10. Responsive layout: the widths, and the phone's bot list ----------
    // Requirement A: desktop has only the sidebar and responsive chat, with no right-panel entry.
    // Geometry and hit-testing are read-only; navigation is exercised through real clicks.
    // A's settings sheet from the account page is a sheet over the workspace, not a column of it.
    assert.equal(await pageA.evaluate("Boolean(document.querySelector('[role=dialog] [data-product-account]'))"), false, "A's account sheet is closed before the layout is measured");
    const noRightPanel = async (width, height) => {
      const state = await pageA.evaluate(`(() => {
        const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
        const entries = [...document.querySelectorAll('[data-product-work-entry], [data-panel-tab], [aria-controls="bot-panel"], [aria-controls="product-work-panel"]')].filter(visible);
        return {
          panel: Boolean(document.querySelector('[data-bot-panel], [data-computer-panel]')),
          scrim: Boolean(document.querySelector('[data-product-work-scrim]')),
          entries: entries.length,
          entryDetails: entries.slice(0, 8).map(node => {
            // Keep only static UI labels/attributes: bot names, account data and arbitrary text stay private.
            const safeLabel = value => /^(computer|activity|details|library|tasks|work|open computer|open work panel)$/i.test((value ?? "").trim()) ? value.trim() : value ? "[redacted]" : "";
            const describe = (element, depth = 0) => {
              const tag = element.tagName.toLowerCase();
              const attrs = [...element.attributes].filter(attr => /^(data-product-work-entry|data-panel-tab|aria-controls|role|type)$/.test(attr.name))
                .map(attr => attr.name + '="' + (/^[a-z0-9_-]{0,64}$/i.test(attr.value) ? attr.value : "[redacted]") + '"').join(" ");
              const children = depth < 2 ? [...element.children].slice(0, 6).map(child => describe(child, depth + 1)).join("") : "";
              return "<" + tag + (attrs ? " " + attrs : "") + ">" + (children || safeLabel(element.textContent)) + "</" + tag + ">";
            };
            return { tag: node.tagName.toLowerCase(), text: safeLabel(node.textContent), outerHTML: describe(node).slice(0, 1600) };
          }),
        };
      })()`);
      (receipt.noRightPanelChecks ??= []).push({ width, height, ...state });
      record("no right panel check", { width, height, ...state });
      assert.equal(state.panel, false, `${width}x${height}: no right-side bot or computer panel`);
      assert.equal(state.scrim, false, `${width}x${height}: no right-panel scrim`);
      assert.equal(state.entries, 0, `${width}x${height}: no visible right-panel opening entry or tabs: ${JSON.stringify(state.entryDetails)}`);
      return state;
    };
    const navigateToBot = async label => {
      const row = `(() => [...document.querySelectorAll('#product-bot-list [data-sidebar-bot-row]')].find(node => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= innerWidth && !node.closest('[inert]');
      }))()`;
      await pageA.until(`Boolean(${row})`, { label: `${label}: a usable sidebar bot row` });
      await pageA.click(`${label}: navigate to a sidebar bot`, row);
      await pageA.until(`Boolean(document.querySelector('[data-product-chat] textarea'))`, { label: `${label}: chat available after bot navigation` });
    };
    const drawerState = `(() => {
      const list = document.querySelector('#product-bot-list');
      const menu = document.querySelector('button[aria-controls="product-bot-list"]');
      const box = list?.getBoundingClientRect();
      return {
        expanded: menu?.getAttribute('aria-expanded') ?? null,
        inert: list?.inert === true,
        right: box ? Math.round(box.right) : null,
        width: box ? Math.round(box.width) : null,
        scrim: Boolean(document.querySelector('[data-sidebar-drawer-scrim]')),
        focus: document.activeElement === menu ? "menu" : document.activeElement?.closest?.('[data-sidebar-drawer-close]') ? "close" : (document.activeElement?.tagName ?? ""),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`;
    for (const [width, height] of [[1440, 900], [1000, 800], [390, 844]]) {
      await pageA.setViewport(width, height);
      await pageA.until(`document.querySelector('[data-sidebar]')?.inert === ${width < 800}`, { label: "sidebar responsive focus state" });
      const overflow = await pageA.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
      assert.ok(overflow <= 1, `no horizontal overflow at ${width}x${height} (overflow ${overflow}px)`);
      // The chat is what a person reads: the composer must be the thing under its own pixels, not a hidden panel's.
      const covered = await pageA.evaluate(`(() => {
        const chat = document.querySelector('[data-product-chat]');
        if (!chat) return "no chat";
        const field = [...chat.querySelectorAll('textarea')].find(node => node.getBoundingClientRect().width > 0);
        const box = field?.getBoundingClientRect();
        if (!box) return "no composer";
        const points = [[box.left + box.width / 2, box.top + box.height / 2], [box.left + 6, box.bottom - 3], [box.right - 6, box.bottom - 3]];
        return points.every(([x, y]) => { const hit = document.elementFromPoint(x, y); return Boolean(hit && chat.contains(hit)); })
          ? "" : "the composer is behind another surface";
      })()`);
      assert.equal(covered, "", `${width}x${height}: ${covered}`);
      const list = await pageA.evaluate(drawerState);
      if (width < 800) {
        assert.equal(list.inert, true, "a phone's shut bot list takes no focus");
        assert.ok(list.right !== null && list.right <= 0, `a phone's shut bot list is off-screen (right ${list.right})`);
      }
      await capture(pageA, `13-layout-${width}x${height}`);
      record("viewport", { width, height, overflow, listWidth: list.width, composerClear: true });
    }

    receipt.noRightPanel = [];
    for (const [width, height] of [[1440, 900], [1000, 800]]) {
      await pageA.setViewport(width, height);
      await pageA.until(`document.querySelector('[data-sidebar]')?.inert === false`, { label: `${width}: desktop sidebar usable` });
      const before = await noRightPanel(width, height);
      await navigateToBot(`${width}x${height}`);
      // Even a dormant header affordance must not resurrect the removed panel.
      await pageA.click("the chat's bot identity", `document.querySelector('[data-chathead-pill]')`);
      const after = await noRightPanel(width, height);
      // Bot settings are legitimate; dismiss them with a real key event before measuring chat.
      for (const type of ["keyDown", "keyUp"]) {
        await pageA.connection.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      }
      await pageA.until(`!document.querySelector('[role="dialog"], [aria-modal="true"]')`, { label: `${width}: bot settings dismissed before layout measurement` });
      await noRightPanel(width, height);
      const geometry = await pageA.evaluate(`(() => {
        const chat = document.querySelector('[data-product-chat]');
        const box = chat?.getBoundingClientRect();
        return { chatWidth: box?.width ?? 0, chatRight: box?.right ?? 0,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          chatOverflow: chat ? chat.scrollWidth - chat.clientWidth : null };
      })()`);
      assert.ok(geometry.chatWidth >= 420, `${width}: chat keeps at least 420px (${geometry.chatWidth}px)`);
      assert.ok(geometry.chatRight <= width + 1, `${width}: chat stays inside the viewport`);
      assert.ok(geometry.overflow <= 1, `${width}: no horizontal page overflow after navigation`);
      assert.ok(geometry.chatOverflow !== null && geometry.chatOverflow <= 1, `${width}: no horizontal chat overflow`);
      const evidence = { width, height, before, after, ...geometry, botNavigation: true, chatheadClicked: true };
      receipt.noRightPanel.push(evidence);
      record("no right panel", evidence);
      await capture(pageA, `13-layout-${width}x${height}-no-right-panel`);
    }

    // The phone's list opens over the chat, dims it, and both Escape and its own close button put it away again.
    await pageA.setViewport(390, 844);
    const shut = await pageA.evaluate(drawerState);
    assert.equal(shut.scrim, false, "a shut bot list paints no scrim");
    const openDrawer = async () => {
      await pageA.click("the bot list button", "document.querySelector('button[aria-controls=\"product-bot-list\"]')");
      // Fully out, not mid-slide: a panel caught half-way out is exactly the defect this checks for.
      return await pageA.untilValue(`(() => { const state = ${drawerState};
        return state.expanded === "true" && state.width >= 200 && state.right >= state.width - 1 ? state : null; })()`, { label: "the bot list drawn over the chat" });
    };
    const openedByButton = await openDrawer();
    assert.equal(openedByButton.scrim, true, "an open bot list dims the chat behind it");
    assert.equal(openedByButton.inert, false, "an open bot list takes focus");
    assert.ok(openedByButton.width < 390 - 24, `the drawer leaves the chat visibly beside it (${openedByButton.width}px)`);
    assert.ok(openedByButton.overflow <= 1, `the open drawer adds no horizontal overflow (${openedByButton.overflow}px)`);
    await capture(pageA, "13-layout-390x844-drawer-open");
    const closeDrawerWith = async (how) => {
      if (how === "Escape") {
        for (const type of ["keyDown", "keyUp"]) {
          await pageA.connection.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
        }
      } else {
        await pageA.click("the bot list's close button", "document.querySelector('[data-sidebar-drawer-close]')");
      }
      const closed = await pageA.untilValue(`(() => { const state = ${drawerState};
        return state.expanded === "false" && state.right <= 0 && state.inert ? state : null; })()`, { label: `the bot list closed by ${how}` });
      // The button that opened it takes focus back, so the keyboard is where it was.
      const refocused = await pageA.untilValue(`(() => { const state = ${drawerState}; return state.focus === "menu" ? state : null; })()`, { label: `focus returned after ${how}`, timeoutMs: 5_000 }).catch(() => null);
      return { ...closed, refocused: refocused?.focus ?? null };
    };
    const afterEscape = await closeDrawerWith("Escape");
    assert.equal(afterEscape.refocused, "menu", "Escape returns focus to the bot list button");
    await openDrawer();
    const afterCloseButton = await closeDrawerWith("close button");
    assert.equal(afterCloseButton.refocused, "menu", "the close button returns focus to the bot list button");
    receipt.drawer = { width: openedByButton.width, scrim: openedByButton.scrim, escape: afterEscape.refocused, closeButton: afterCloseButton.refocused };
    record("viewport drawer", receipt.drawer);
    await openDrawer();
    await navigateToBot("phone bot list");
    await pageA.untilValue(`(() => { const state = ${drawerState};
      return state.expanded === "false" && state.right <= 0 && state.inert ? state : null; })()`, { label: "phone bot navigation closes the list" });
    const phoneOverflow = await pageA.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
    assert.ok(phoneOverflow <= 1, `phone bot navigation adds no horizontal overflow (${phoneOverflow}px)`);
    receipt.drawer.botNavigation = true;
    await capture(pageA, "13-layout-390x844-bot-selected");
    await pageA.setViewport(1440, 900);

    const operatorCredit = await pageA.evaluate("window.hezuo.productAccount.operatorStatus()");
    assert.equal(operatorCredit.eligible, true);
    const maximumCredit = await pageA.evaluate("window.hezuo.productAccount.grantMaximum()");
    assert.equal(maximumCredit.outcome, "granted");
    assert.equal(maximumCredit.amountMicroPoints, operatorCredit.maxGrantMicroPoints);
    const afterMaximum = await operatorSession.client.aiStatus(operatorSession.token);
    assert.equal(BigInt(afterMaximum.availableMicroPoints) + BigInt(afterMaximum.reservedMicroPoints), BigInt(Number.MAX_SAFE_INTEGER));
    const repeatedMaximum = await pageA.evaluate("window.hezuo.productAccount.grantMaximum()");
    assert.equal(repeatedMaximum.outcome, "already_max");
    receipt.operatorCredit = { outcome: maximumCredit.outcome, amountMicroPoints: maximumCredit.amountMicroPoints, repeated: repeatedMaximum.outcome };

    // ---------- 11. Sign-out revokes live model tokens ----------
    await signOutWorkspace(pageA);
    await waitForPage(debugPort, /\/product-account\.html/, { description: "the gate after the final sign-out", timeoutMs: 120_000 });
    // The account session itself is gone now; the token check below reads the database, not an API.
    // Revocation is a network call main starts as it stops the runtime; poll briefly for it.
    let tokens = { n: 1 };
    for (let attempt = 0; attempt < 60 && tokens.n !== 0; attempt++) {
      tokens = await worker.db().prepare(
        "SELECT COUNT(*) AS n FROM account_ai_tokens WHERE owner_user_id = ? AND revoked_at IS NULL AND expires_at > ?",
      ).bind(operatorId, Date.now()).first();
      if (tokens.n !== 0) await sleep(250);
    }
    receipt.processes.liveModelTokens = tokens.n;
    assert.equal(tokens.n, 0, "sign-out left no usable model token");
    const sessions = await worker.db().prepare(
      'SELECT COUNT(*) AS n FROM "session" WHERE id IN (SELECT session_id FROM account_ai_tokens WHERE owner_user_id = ?)'
    ).bind(operatorId).first();
    receipt.processes.liveAccountSessions = sessions.n;
    assert.equal(sessions.n, 0, "sign-out invalidated every application account session");

    // ---------- 12. Storage facts: encrypted login, per-account roots, untouched legacy ----------
    const userData = join(root, "user-data");
    assert.equal(existsSync(join(userData, "product-account.bin")), false, "sign-out removed the encrypted login record");
    const accountRoots = (await import("node:fs")).readdirSync(join(userData, "product-accounts"));
    assert.equal(accountRoots.length, 2, `one workspace root per account (${accountRoots.join(", ")})`);
    assert.equal(existsSync(join(root, "home", ".hezuo")), false, "no legacy ~/.hezuo was created or read");
    receipt.userData = { loginRecordRemoved: true, accountRoots: accountRoots.length, legacyUntouched: true };

    receipt.mailCount = worker.mail.count();
    receipt.models = MODELS;
    record("finished");
  } catch (error) {
    receipt.errors.push(error?.stack ?? String(error));
    const failed = await accountSnapshot(page) ?? await accountSnapshot(liveGate ?? gate);
    if (page) await capture(page, "failure-workspace").catch(() => {});
    if (failed) receipt.failureState = failed;
    receipt.failureStorage = {
      loginRecord: existsSync(join(root, "user-data", "product-account.bin")),
      accountRoots: existsSync(join(root, "user-data", "product-accounts")),
    };
    if (app) receipt.processes.appLogTail = app.logs();
  } finally {
    gate?.close(); page?.close();
    if (app && app.child.exitCode === null) {
      app.child.kill("SIGTERM");
      const stopped = await Promise.race([app.exited.then(() => true), sleep(15_000).then(() => false)]);
      if (!stopped) app.child.kill("SIGKILL");
      receipt.processes.appExit = await Promise.race([app.exited, sleep(3_000).then(() => null)]);
      receipt.processes.appLogTail = app.logs();
    }
    if (socketDirectory) {
      try {
        rmSync(socketDirectory, { recursive: true, force: true });
        receipt.browserSocketDirectory.cleaned = !existsSync(socketDirectory);
        if (!receipt.browserSocketDirectory.cleaned) receipt.errors.push("Owned browser socket directory still exists");
      } catch (error) {
        receipt.browserSocketDirectory.cleanupError = error.message;
        receipt.errors.push(`Owned browser socket cleanup failed: ${error.message}`);
      }
    }
    await worker?.close().catch(() => {});
    if (worker) {
      receipt.inferenceRequests = worker.inferenceRequests;
      receipt.inferenceLog = worker.inferenceLog;
      receipt.upstreamCalls = worker.upstream.state.calls.slice();
      const rejectedBilling = worker.inferenceRequests.find(request => request.status === 400
        && request.errorCode === "invalid_request" && request.fields.includes("billing"));
      if (rejectedBilling) receipt.compatibilityDiagnostic = "The desktop sent billing, but this checkout Worker rejected the request. Check the gateway billing contract; do not strip the desktop budget to make this fixture pass.";
    }
    receipt.passed = receipt.errors.length === 0;
    receipt.finishedAt = new Date().toISOString();
    writeFileSync(join(root, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    writeFileSync(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    if (!options.keep) {
      for (const name of ["user-data", "home", "bin"]) {
        try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    console.log(`\nevidence: ${evidence}`);
    console.log(`receipt: ${join(evidence, "receipt.json")}`);
    console.log(`result: ${receipt.passed ? "passed" : "failed"}`);
    if (!receipt.passed) console.log(receipt.errors.join("\n"));
  }
  if (!receipt.passed) process.exitCode = 1;
}

await main();
