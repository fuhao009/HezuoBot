import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceFlow, initialFlow, type FlowEvent } from '../src/execution-flow.ts';

const event = (name: string, extra: Partial<FlowEvent> = {}): FlowEvent => ({ name, ok: true, hasScreenshot: false, ...extra });

test('tracks mixed surfaces without treating observations as business success', () => {
  const initial = initialFlow();
  const web = advanceFlow(initial, event('browser_open', { detail: { actionComplete: true, state: { untrusted: true, url: 'secret' } } }));
  assert.equal(web.surface, 'web');
  assert.equal(web.stage, 'verify');
  assert.equal(web.verification, 'observation_available');
  const native = advanceFlow(web, event('desktop_click'));
  assert.equal(native.surface, 'native');
  assert.equal(native.verification, 'needs_observation');
  const visual = advanceFlow(native, event('computer_window', { hasScreenshot: true }));
  assert.equal(visual.surface, 'visual');
  assert.equal(visual.observations, 2);
  assert.equal(visual.verification, 'observation_available');
  assert.equal(visual.operations, 3);
  assert.deepEqual(initial, initialFlow());
  assert.doesNotMatch(JSON.stringify(visual), /secret/);
});

test('pending dialogs and failed requests block without deriving codes from text', () => {
  const pending = advanceFlow(initialFlow(), event('browser_click', { code: 'dialog-pending', detail: { actionComplete: false } }));
  assert.equal(pending.stage, 'blocked');
  assert.equal(pending.verification, 'needs_observation');
  assert.deepEqual(pending.recovery, { code: 'dialog-pending', next: 'ask_user' });
  const unknown = advanceFlow(pending, event('browser_read', { ok: false, code: 'private text', detail: { code: 'timeout' }, hasScreenshot: true }));
  assert.equal(unknown.stage, 'blocked');
  assert.equal(unknown.recovery, undefined);
  assert.equal(unknown.verification, 'needs_observation');
  assert.equal(unknown.observations, 0);
});

test('combined calls use backend flags and never replay after observation failure', () => {
  const detail = { actionOk: true, observationAttempted: true, observationOk: true };
  const success = advanceFlow(initialFlow(), event('desktop_click_and_snapshot', { detail }));
  assert.equal(success.stage, 'verify');
  assert.equal(success.verification, 'observation_available');
  const fail = advanceFlow(success, event('computer_action_and_screenshot', { ok: false, code: 'CANCELLED', detail: { ...detail, observationOk: false } }));
  assert.equal(fail.stage, 'blocked');
  assert.equal(fail.verification, 'needs_observation');
  assert.deepEqual(fail.recovery, { code: 'CANCELLED', next: 'observe' });
  assert.equal(fail.observations, 1);
  const missingImage = advanceFlow(fail, event('computer_action_and_screenshot', { detail }));
  assert.equal(missingImage.verification, 'needs_observation');
  const captured = advanceFlow(fail, event('computer_action_and_screenshot', { detail, hasScreenshot: true }));
  assert.equal(captured.verification, 'observation_available');
  const skipped = advanceFlow(success, event('desktop_set_value_and_snapshot', { detail: { actionOk: true, observationAttempted: false } }));
  assert.equal(skipped.verification, 'needs_observation');
});

test('browser read-after-action and interrupted observation are distinguished', () => {
  const action = advanceFlow(initialFlow(), event('browser_click', { detail: { actionIssued: true, actionComplete: true, observation: 'read' } }));
  assert.equal(action.verification, 'observation_available');
  const interrupted = advanceFlow(action, event('browser_click', { ok: false, code: 'observation-failed', detail: { actionComplete: true, observationComplete: false, state: { untrusted: true } } }));
  assert.equal(interrupted.verification, 'needs_observation');
  assert.equal(interrupted.observations, 1);
  const read = advanceFlow(interrupted, event('browser_read'));
  assert.equal(read.verification, 'observation_available');
  assert.equal(read.recovery, undefined);
});

test('unknown tools do not inject data or infer surface and state inputs remain unchanged', () => {
  const previous = advanceFlow(initialFlow(), event('browser_click', { ok: false, code: 'stale-ref' }));
  const before = structuredClone(previous);
  const result = advanceFlow(previous, event('browser_unknown_secret_url', { detail: { actionOk: true }, hasScreenshot: true }));
  assert.deepEqual(previous, before);
  assert.deepEqual(result, { ...before, operations: before.operations + 1 });
  assert.notEqual(result.recovery, previous.recovery);
  assert.doesNotMatch(JSON.stringify(result), /secret_url/);
});

test('failed screenshots and arbitrary detail are not evidence of observation', () => {
  const action = advanceFlow(initialFlow(), event('computer_click'));
  const failed = advanceFlow(action, event('computer_window', { ok: false, hasScreenshot: true, detail: 'sensitive' }));
  assert.equal(failed.verification, 'needs_observation');
  assert.equal(failed.observations, 0);
  const invalid = advanceFlow(failed, event('computer_window'));
  assert.equal(invalid.verification, 'needs_observation');
  assert.equal(invalid.observations, 0);
});

test('cached status, waits and native inventory do not replace a fresh observation', () => {
  const action = advanceFlow(initialFlow(), event('desktop_click'));
  for (const name of ['computer_status', 'browser_wait', 'desktop_wait', 'desktop_list_apps', 'desktop_list_windows']) {
    const next = advanceFlow(action, event(name, { detail: { state: { untrusted: true } } }));
    assert.equal(next.verification, 'needs_observation', name);
    assert.equal(next.observations, 0, name);
  }
  const waited = advanceFlow(action, event('browser_wait_for'));
  assert.equal(waited.surface, 'web');
  assert.equal(waited.verification, 'observation_available');
});

test('known structured recovery codes use fixed mappings and pending blocks', () => {
  for (const [code, next] of [
    ['STALE_REF', 'observe'], ['OBSERVATION_FAILED', 'observe'], ['FOCUS_REQUIRED', 'prepare'],
    ['PERMISSION_DENIED', 'ask_user'], ['ACTION_PENDING', 'wait'], ['DIALOG_PENDING', 'wait'],
    ['HTTP_ERROR', 'inspect'], ['AX_ACTION_FAILED', 'inspect'],
  ] as const) {
    const result = advanceFlow(initialFlow(), event('desktop_click', { ok: false, code }));
    assert.deepEqual(result.recovery, { code, next });
  }
  assert.equal(advanceFlow(initialFlow(), event('desktop_click', { code: 'ACTION_PENDING' })).stage, 'blocked');
});

test('preparation invalidates stale surface observations', () => {
  const observed = advanceFlow(initialFlow(), event('browser_read'));
  for (const name of ['desktop_launch', 'desktop_focus_window', 'browser_viewport', 'browser_switch']) {
    assert.equal(advanceFlow(observed, event(name)).verification, 'needs_observation', name);
  }
  assert.equal(advanceFlow(observed, event('browser_switch', { detail: { state: { untrusted: true } } })).verification, 'observation_available');
  assert.equal(advanceFlow(observed, event('desktop_list_windows')).verification, 'not_observed');
  const pending = advanceFlow(observed, event('browser_click', { code: 'action-pending' }));
  assert.equal(pending.stage, 'blocked');
  assert.deepEqual(pending.recovery, { code: 'action-pending', next: 'wait' });
});
