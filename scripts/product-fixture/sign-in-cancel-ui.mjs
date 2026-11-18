import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { sendMessage, waitSettled, workspaceApi } from "./account-ui.mjs";
import { checkpointPanelAbsence } from "./panel-absence-ui.mjs";

export async function verifySignInCancellation({ page, worker, botId, receipt, capture }) {
  const evidence = receipt.signInCancellation = {
    realModelAcceptance: false, status: "running", scope: "Synthetic upstream, real product tool routing and UI cancellation only",
    nativeWindowObservation: "CDP page target creation, including transient targets",
    nativeWindowVerified: false,
  };
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Fixture sign-in</title><h1>Local fixture sign-in</h1>");
  });
  await new Promise((resolve, reject) => {
    site.once("error", reject);
    site.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://example.test:${site.address().port}/sign-in`;
  const previousScenario = worker.upstream.state.scenario;
  const callStart = worker.upstream.state.calls.length;
  let eventStart;
  try {
    await waitSettled(page);
    await workspaceApi(page, "PATCH", `/api/bots/${botId}`, { browser: true });
    await page.connection.send("Target.setDiscoverTargets", { discover: true });
    eventStart = page.connection.events.length;
    worker.upstream.state.signInUrl = url;
    worker.upstream.state.scenario = "sign-in";
    const snapshot = `(async () => {
      const response = await fetch('/api/bots');
      if (!response.ok) throw new Error('bots HTTP ' + response.status);
      return (await response.json()).bots.find(bot => bot.id === ${JSON.stringify(botId)});
    })()`;
    const before = await page.evaluate(snapshot);
    const prior = before.messages.filter(message => message.kind === "signin").map(message => message.id);
    await sendMessage(page, `Use your browser for ${url}. Call request_sign_in for this site so I can sign in myself; do not open a sign-in window.`);
    const pending = await page.untilValue(`(async () => {
      const bot = await ${snapshot};
      return bot?.messages.find(message => message.kind === 'signin' && message.signIn?.site === 'example.test'
        && !${JSON.stringify(prior)}.includes(message.id) && !message.signIn.cancelled && !message.signIn.done) ?? null;
    })()`, { label: "real request_sign_in card (requires a mounted browser/computer; requestSignIn returns 409 otherwise)", timeoutMs: 120_000 });
    evidence.messageId = pending.id;
    evidence.place = pending.signIn.place;
    evidence.url = pending.signIn.url;
    assert.equal(pending.signIn.url, url);
    assert.ok(worker.upstream.state.calls.slice(callStart).some(call => call.requestSignInOffered), "actual request_sign_in tool was offered by the product");
    await page.until(`document.querySelector('[data-testid="sign-in-site"]')?.textContent.includes('example.test')`, { label: "real sign-in card rendered" });
    await checkpointPanelAbsence(page, receipt, "sign-in-pending");
    await capture(page, "sign-in-pending");
    await page.click("Cancel on the example.test sign-in card", `(() => {
      const text = [...document.querySelectorAll('[data-testid="sign-in-site"]')].find(node => node.textContent.includes('example.test'));
      const card = text?.closest('[aria-label]');
      return [...(card?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === 'Cancel' && !button.disabled);
    })()`);
    const cancelled = await page.untilValue(`(async () => {
      const bot = await ${snapshot};
      const message = bot?.messages.find(message => message.id === ${JSON.stringify(pending.id)});
      return message?.signIn?.cancelled === true ? message : null;
    })()`, { label: "API sign-in card cancelled" });
    assert.notEqual(cancelled.signIn.done, true);
    evidence.apiCard = { id: cancelled.id, ...cancelled.signIn };
    await waitSettled(page);
    await checkpointPanelAbsence(page, receipt, "sign-in-cancelled");
    await capture(page, "sign-in-cancelled");
    const created = page.connection.events.slice(eventStart).filter(event => event.method === "Target.targetCreated" && event.params?.targetInfo?.type === "page");
    evidence.newPageTargets = created.map(event => ({ id: event.params.targetInfo.targetId, url: event.params.targetInfo.url }));
    assert.deepEqual(evidence.newPageTargets, [], "no native page window target created during request/cancel");
    evidence.status = "ui-cancelled-no-new-page-target";
    evidence.nativeWindowVerified = true;
    for (const key of ["signInRequest", "cancelWithoutNativeWindow", "cancelledApiCard"]) delete receipt.panelAbsence.uncovered[key];
    const activity = receipt.browserAndComputerActivity = {
      realModelAcceptance: false,
      scope: "Synthetic model; real public-network browsing of https://example.com/, actual offered browser tools, tool results, API messages and DOM observation",
      browser: { status: "running", url: "https://example.com/", expectedTitle: "Example Domain" },
      computer: {
        status: "not-exercised-safety-gap", controlSucceeded: false,
        reason: "No independently verified isolated computer display. Screenshot may expose the daily desktop; no screenshot, mouse or keyboard tool is called. Tool refusal would not prove control success.",
      },
      onboarding: {
        status: "not-applicable-managed-product", isolatedProfileUiVerified: false,
        reason: "desktop/src/App.tsx ProductSetupGate returns null for isProductWorkspace(config.productManaged). A fresh profile does not bypass this managed-product gate. No normal-UI onboarding trigger or React injection; non-managed isolated-profile UI remains unverified.",
      },
    };
    const browserStart = worker.upstream.state.calls.length;
    const browserUrl = "https://example.com/";
    const run = { id: `fixture-browser-${randomUUID()}`, url: browserUrl, generated: [] };
    worker.upstream.state.browserRun = run;
    activity.browser.generatedCalls = run.generated;
    activity.browser.approvals = [];
    worker.upstream.state.scenario = "browser-panel-absence";
    await sendMessage(page, `Use only the offered agent_browser tools to open ${browserUrl} and read its title. Do not use computer tools or request sign-in.`);
    const requestDeadline = Date.now() + 30_000;
    while (worker.upstream.state.calls.length <= browserStart && Date.now() < requestDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (worker.upstream.state.calls.length <= browserStart) {
      activity.browser.status = "upstream-request-timeout";
      activity.browser.diagnostic = { browserStart, callCount: worker.upstream.state.calls.length, timeoutMs: 30_000 };
      throw new Error("Browser scenario: no upstream request within 30s; stopping before account sign-out to avoid request spillover");
    }
    // Do not waitSettled while a permission card is waiting for a person.
    // Only this run's actual upstream output can authorize a UI click.
    const approved = new Set();
    const browserDeadline = Date.now() + 120_000;
    const currentResults = () => worker.upstream.state.calls.slice(browserStart)
      .flatMap(call => call.fixtureBrowserResults ?? []);
    const successful = result => {
      if (!result || !result.content) return false;
      const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      const failed = value => {
        if (typeof value === "string") {
          try { return failed(JSON.parse(value)); } catch { return false; }
        }
        if (!value || typeof value !== "object") return false;
        if (value.ok === false || value.isError === true || value.error) return true;
        return Object.values(value).some(failed);
      };
      // MCP content may contain JSON text blocks wrapping the real { ok, result }.
      return !failed(result.content) && text.trim().length > 0
        && !/"ok"\s*:\s*false|"isError"\s*:\s*true|"error"\s*:|\b(denied|refused|failed|error|cancelled)\b/i.test(text);
    };
    let titleResult;
    while (Date.now() < browserDeadline) {
      const results = currentResults();
      const openResult = results.find(result => result.id === `${run.id}-open`);
      titleResult = results.find(result => result.id === `${run.id}-title`);
      for (const result of [openResult, titleResult].filter(Boolean)) {
        assert.ok(successful(result), `Browser tool failed: ${JSON.stringify(result)}`);
        assert.ok(approved.has(result.id), `Result without this run's UI approval: ${result.id}`);
      }
      const bot = await page.evaluate(snapshot);
      const pending = bot.messages.filter(message => message.card?.requestType === "permission"
        && message.card.requestId && !message.card.answered && !message.card.dismissed
        && !message.card.expired && !message.card.stopped);
      for (const message of pending) {
        const card = message.card;
        const generated = run.generated.find(call => call.id === card.toolCallId);
        activity.browser.pendingCard = { messageId: message.id, requestId: card.requestId,
          toolCallId: card.toolCallId, tool: card.tool, browserTarget: card.browserTarget };
        assert.ok(generated, `Unknown approval call: ${JSON.stringify(activity.browser.pendingCard)}`);
        assert.equal(card.tool, generated.name, "approval tool must match actual emitted name");
        if (generated.name === "browser_agent_browser_open") {
          assert.deepEqual(generated.args, { url: browserUrl });
          assert.equal(card.browserTarget?.operation, "open");
          assert.equal(card.browserTarget.origin, "https://example.com", "only the public example.com origin may be opened");
        } else {
          assert.equal(generated.name, "browser_agent_browser_get_title", "no other tool may be approved");
          assert.deepEqual(generated.args, {});
          assert.equal(card.browserTarget, undefined, "unknown title target must not be approved");
          assert.ok(successful(openResult) && approved.has(`${run.id}-open`), "title requires this run's completed real open result");
        }
        if (approved.has(generated.id)) continue;
        // Production DOM links the visible card's details to its requestId.
        // The click helper sends real pointer input; no answer API or DOM .click().
        await page.click(`Allow once for ${generated.id}`, `(() => {
          const details = document.getElementById(${JSON.stringify(`approval-details-${card.requestId}`)});
          const region = details?.closest('[data-ask-card="approval"]');
          return [...(region?.querySelectorAll('button') ?? [])].find(button =>
            button.textContent.trim() === 'Allow once' && !button.disabled);
        })()`);
        approved.add(generated.id);
        activity.browser.approvals.push({ ...activity.browser.pendingCard, generated, action: "Allow once" });
      }
      if (titleResult) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    activity.browser.toolResults = currentResults();
    assert.ok(titleResult, `Browser result timeout: ${JSON.stringify({ generated: run.generated,
      approvals: activity.browser.approvals, pending: activity.browser.pendingCard, results: currentResults() })}`);
    assert.ok(JSON.stringify(titleResult.content).includes("Example Domain"), "real title result must contain Example Domain");
    await waitSettled(page);
    const browserCalls = worker.upstream.state.calls.slice(browserStart);
    const results = currentResults();
    activity.browser.toolOffers = browserCalls.map(call => call.toolNames);
    activity.browser.toolResults = results;
    const missingTools = ["browser_agent_browser_open", "browser_agent_browser_get_title"].filter(name =>
      !browserCalls.some(call => call.toolNames.includes(name)));
    if (missingTools.length) {
      activity.browser.status = "blocked-tool-not-offered";
      activity.browser.missingTools = missingTools;
      throw new Error(`Browser scenario blocked: product did not offer ${missingTools.join(", ")}`);
    }
    const apiBot = await page.evaluate(snapshot);
    activity.browser.apiToolEvents = apiBot.messages.filter(message => message.kind === "tool" && /agent_browser/.test(JSON.stringify(message)));
    await checkpointPanelAbsence(page, receipt, "browser-open-read-title");
    await capture(page, "browser-open-read-title");
    const titleText = JSON.stringify(titleResult?.content ?? "");
    activity.browser.status = successful(titleResult) && titleText.includes("Example Domain")
      ? "public-example-title-read-no-panel" : "blocked-or-unverified";
    activity.browser.controlSucceeded = activity.browser.status === "public-example-title-read-no-panel";
    assert.ok(activity.browser.controlSucceeded, `Browser result unverified: ${JSON.stringify(titleResult)}`);
    receipt.panelAbsence.uncovered.browserAndComputerActivity = activity.browser.controlSucceeded
      ? "Real public-network browser open/title at https://example.com/ verified with a synthetic model, not real-model acceptance. Computer not exercised: isolated display safety not established."
      : "Browser open/title did not yield a verified title result; computer not exercised for desktop privacy.";
    receipt.panelAbsence.uncovered.onboarding = activity.onboarding.reason;
  } catch (error) {
    evidence.status = "blocked-or-failed";
    if (receipt.browserAndComputerActivity?.browser) {
      receipt.browserAndComputerActivity.browser.status = "blocked-or-failed";
      receipt.browserAndComputerActivity.browser.controlSucceeded = false;
      receipt.browserAndComputerActivity.browser.error = error.message;
    }
    evidence.error = error.message;
    evidence.toolCalls = worker.upstream.state.calls.slice(callStart).map(call => ({ toolNames: call.toolNames, hasToolResult: call.hasToolResult, requestSignInOffered: call.requestSignInOffered, fixtureBrowserGenerated: call.fixtureBrowserGenerated, fixtureBrowserResults: call.fixtureBrowserResults }));
    throw error;
  } finally {
    worker.upstream.state.scenario = previousScenario;
    await page.connection.send("Target.setDiscoverTargets", { discover: false }).catch(() => {});
    await new Promise(resolve => { site.closeAllConnections?.(); site.close(resolve); });
  }
}
