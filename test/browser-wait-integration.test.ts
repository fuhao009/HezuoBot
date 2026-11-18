import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { BrowserSession } from '../src/browser.ts';

// Real headless Chromium against an in-memory route: no external site or desktop input.
test('conditional waits execute their predicate in real Chromium and exclude hidden text', async t => {
  const session = new BrowserSession({ headless: true });
  const start = Reflect.get(session, 'start');
  assert.equal(typeof start, 'function');
  try {
    await start.call(session);
    const context = Reflect.get(session, 'context');
    assert.ok(context);
    await context.route('**/*', (route: { fulfill(value: { contentType: string; body: string }): Promise<void> }) => route.fulfill({
      contentType: 'text/html', body: '<html><head><title>Observation fixture</title></head><body><div hidden>hidden-only-target</div><div>Visible target</div><input aria-label="Name" value="fixture" maxlength="8" required><button>Next</button></body></html>',
    }));
    const opened = await session.execute('browser_open', JSON.stringify({ url: 'https://93.184.216.34/fixture', observe: 'read' }));
    assert.equal(opened.ok, true);
    const page = Reflect.get(session, 'page') as Page;
    const stateEvaluations = t.mock.method(page, 'evaluate');
    const titleReads = t.mock.method(page, 'title');
    const matched = await session.execute('browser_wait_for', JSON.stringify({ url: 'https://93.184.216.34/fixture', url_match: 'exact', text: 'Visible target', condition: 'all', timeout_ms: 1000, observe: 'read' }));
    assert.equal(matched.ok, true);
    assert.equal(matched.detail?.conditionObserved, true);
    assert.equal(matched.detail?.observation, 'read');
    assert.equal(stateEvaluations.mock.callCount(), 1, 'wait plus read samples page state only once');
    assert.equal(titleReads.mock.callCount(), 1, 'read title is not repeated by pageState');
    const snapshot = JSON.parse(matched.text.slice('Condition observed. '.length));
    assert.equal(snapshot.state.title, 'Observation fixture');
    const field = snapshot.elements.find((element: { label: string }) => element.label === 'Name');
    assert.equal(field.value, 'fixture');
    assert.equal(field.constraints.maxLength, 8);
    assert.equal(field.constraints.lengthUnits, 'UTF-16');
    assert.equal(field.constraints.required, true);
    stateEvaluations.mock.restore();
    titleReads.mock.restore();
    const hidden = await session.execute('browser_wait_for', JSON.stringify({ text: 'hidden-only-target', timeout_ms: 50 }));
    assert.equal(hidden.ok, false);
    assert.equal(hidden.code, 'condition-timeout');
    assert.equal(hidden.detail?.conditionObserved, false);
    const either = await session.execute('browser_wait_for', JSON.stringify({ url: 'https://not-the-page.invalid/', url_match: 'exact', text: 'Visible target', condition: 'any', timeout_ms: 1000 }));
    assert.equal(either.ok, true);
    const abort = new AbortController();
    const waitStarted = Promise.withResolvers<void>();
    const originalWait = page.waitForFunction.bind(page);
    const waitSpy = t.mock.method(page, 'waitForFunction', (...args: Parameters<Page['waitForFunction']>) => {
      const wait = originalWait(...args);
      waitStarted.resolve();
      return wait;
    });
    const pending = session.execute('browser_wait_for', JSON.stringify({ text: 'never-present-target' }), abort.signal);
    try {
      await waitStarted.promise;
      abort.abort();
      const cancelled = await pending;
      assert.equal(cancelled.ok, false);
      assert.equal(cancelled.code, 'cancelled');
    } finally { waitSpy.mock.restore(); }
    const resumed = await session.execute('browser_read', '{}');
    assert.equal(resumed.ok, true, resumed.text);
    const matchedAgain = await session.execute('browser_wait_for', JSON.stringify({ text: 'Visible target', timeout_ms: 1000 }));
    assert.equal(matchedAgain.ok, true, matchedAgain.text);
  } finally { await session.close(); }
});
