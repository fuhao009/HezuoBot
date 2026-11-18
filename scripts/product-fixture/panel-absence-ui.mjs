import assert from "node:assert/strict";

const PANEL_SELECTOR = '[data-computer-panel], [data-testid="computer-tabs"], [data-tour="computer-tabs"]';

export async function startPanelAbsenceObservation(page, receipt) {
  receipt.panelAbsence = {
    realModelAcceptance: false,
    completeAcceptance: false,
    status: "partial-ui-observation-only",
    scope: "Real Electron DOM during the existing synthetic-upstream account and MCP acceptance",
    checkpoints: [],
    uncovered: {
      signInRequest: "The existing fixture emits only text and MCP write calls; no request_sign_in event was exercised.",
      cancelWithoutNativeWindow: "No pending browser sign-in card was produced; cancellation and native window absence are not verified.",
      cancelledApiCard: "No sign-in cancellation was exercised; API card cancellation state is not verified.",
      realModelReplyAfterCancel: "Not proved: no real model credentials or cancellation continuation acceptance.",
      browserAndComputerActivity: "The existing MCP file-write event is not browser or computer activity; those automatic triggers remain unverified.",
      onboarding: "Managed account onboarding is suppressed by the product gate; no onboarding automatic-open trigger was exercised.",
    },
  };
  await page.evaluate(`(() => {
    const selector = ${JSON.stringify(PANEL_SELECTOR)};
    const observations = { samples: 0, violations: [] };
    const inspect = () => {
      observations.samples++;
      if (document.querySelector(selector) && observations.violations.length < 20) observations.violations.push({ at: Date.now(), kind: 'mounted-panel' });
    };
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === 1 && observations.violations.length < 20 && (node.matches(selector) || node.querySelector(selector))) {
          observations.violations.push({ at: Date.now(), kind: 'inserted-panel' });
        }
      }
      inspect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    inspect();
    window.__productFixturePanelObservation = { observations, observer };
    return true;
  })()`);
}

export async function checkpointPanelAbsence(page, receipt, label) {
  const snapshot = await page.evaluate(`(() => {
    const monitor = window.__productFixturePanelObservation;
    if (!monitor) throw new Error('Panel absence observer is not attached to this page');
    return {
      label: ${JSON.stringify(label)},
      at: Date.now(),
      samples: monitor.observations.samples,
      violations: monitor.observations.violations,
      panelMounted: Boolean(document.querySelector(${JSON.stringify(PANEL_SELECTOR)})),
      chatVisible: Boolean(document.querySelector('[data-product-chat] textarea')?.getClientRects().length),
    };
  })()`);
  receipt.panelAbsence.checkpoints.push(snapshot);
  assert.equal(snapshot.panelMounted, false, `${label}: no right computer panel mounted`);
  assert.deepEqual(snapshot.violations, [], `${label}: no transient right computer panel observed`);
  assert.equal(snapshot.chatVisible, true, `${label}: the real product chat remains visible`);
}
