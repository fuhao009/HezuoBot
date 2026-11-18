import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createWebServer, type ChatSession } from '../src/web-server.ts';
import { loadConfig } from '../src/config.ts';
import type { ExecutionState } from '../src/scenarios.ts';

const secret = 'flow-performance-secret-never-public';
const config = loadConfig({
  HEZUO_CORE_MODEL: 'flow-performance-fixture',
  HEZUO_CORE_BASE_URL: 'https://model.invalid/v1',
  HEZUO_CORE_API_KEY: secret,
  HEZUO_CORE_TOOLS: '',
});
const execution = (overrides: Record<string, unknown> = {}): ExecutionState => ({
  run: 1, scenario: 'web', source: 'auto', phase: 'tool', round: 2,
  elapsedMs: 3500, modelMs: 2400, toolMs: 600, modelRequests: 2, toolCalls: 3,
  updatedAt: 123456, ...overrides,
} as ExecutionState);
const flow = (overrides: Record<string, unknown> = {}) => ({
  surface: 'web', stage: 'verify', operations: 3, observations: 2,
  verification: 'needs_observation', lastOperation: 'browser_click', ...overrides,
});
const timing = (overrides: Record<string, unknown> = {}) => ({
  headersMs: 120, firstChunkMs: 350, bodyMs: 1900, parseMs: 30,
  firstChunkMeasured: true, ...overrides,
});
type State = { token: string; execution: ExecutionState | null; messages: unknown[] };

async function withWeb(
  snapshot: () => ExecutionState | undefined,
  run: (state: () => Promise<State>) => Promise<void>,
) {
  const app = createWebServer(config, (): ChatSession => ({
    async send() { return 'fixture reply'; },
    cancel() {}, async close() {}, executionState: snapshot,
  }), 0);
  try {
    const ready = Promise.withResolvers<void>();
    app.server.once('error', ready.reject);
    app.server.listen(0, '127.0.0.1', ready.resolve);
    await ready.promise;
    const address = app.server.address();
    assert(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const state = async (): Promise<State> => {
      const response = await fetch(`${origin}/api/state`);
      assert.equal(response.status, 200);
      return await response.json() as State;
    };
    const { token } = await state();
    const response = await fetch(`${origin}/api/send`, {
      method: 'POST',
      headers: { origin, 'x-session-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'flow performance fixture' }),
    });
    assert.equal(response.status, 202);
    await run(state);
  } finally {
    try { await app.shutdown(); }
    finally {
      app.server.closeAllConnections();
      if (app.server.listening) {
        const closed = Promise.withResolvers<void>();
        app.server.close(error => error ? closed.reject(error) : closed.resolve());
        await closed.promise;
      }
    }
  }
}

test('web flow/performance: legacy execution remains valid without optional telemetry', async () => {
  let current: ExecutionState | undefined = execution();
  await withWeb(() => current, async state => {
    assert.deepEqual((await state()).execution, execution());
    current = execution({ flow: null, modelTiming: null });
    assert.deepEqual((await state()).execution, execution());
    current = undefined;
    assert.equal((await state()).execution, null);
  });
});

test('web flow/performance: valid optional fields are projected independently and refresh on polling', async () => {
  let current = execution({ flow: flow(), modelTiming: timing() });
  await withWeb(() => current, async state => {
    assert.deepEqual((await state()).execution, current);
    current = execution({ flow: flow({ operations: 4, observations: 3, stage: 'observe' }) });
    assert.deepEqual((await state()).execution, current);
    current = execution({ modelTiming: timing({ firstChunkMs: 0, firstChunkMeasured: false }) });
    assert.deepEqual((await state()).execution, current);
    current = execution();
    assert.deepEqual((await state()).execution, current);
  });
});

test('web flow/performance: nested telemetry is allowlisted, never a session or tool-result dump', async () => {
  const privateData = {
    prompt: secret, response: secret, arguments: { password: secret },
    url: `https://private.invalid/?token=${secret}`, screenshot: secret,
    error: secret, detail: secret, messages: [secret], apiKey: secret,
  };
  const current = execution({
    ...privateData,
    flow: flow({ ...privateData, recovery: { code: 'TOOL_FAILED', next: 'inspect', message: secret } }),
    modelTiming: timing(privateData),
  });
  await withWeb(() => current, async state => {
    const result = await state();
    assert.deepEqual(result.execution, execution({ flow: flow(), modelTiming: timing() }));
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes('private.invalid'), false);
  });
});

test('web flow/performance: malformed timing is omitted without discarding valid execution or flow', async () => {
  let current = execution();
  const invalid: unknown[] = [undefined, null, -1, NaN, Infinity, -Infinity, '120', true, {}, [], Number.MAX_SAFE_INTEGER + 1];
  await withWeb(() => current, async state => {
    for (const key of ['headersMs', 'firstChunkMs', 'bodyMs', 'parseMs']) {
      for (const value of invalid) {
        current = execution({ flow: flow(), modelTiming: timing({ [key]: value }) });
        assert.deepEqual((await state()).execution, execution({ flow: flow() }), `${key}: ${String(value)}`);
      }
    }
    for (const value of [undefined, null, 0, 1, 'false', {}, []]) {
      current = execution({ flow: flow(), modelTiming: timing({ firstChunkMeasured: value }) });
      assert.deepEqual((await state()).execution, execution({ flow: flow() }));
    }
    for (const value of [false, true]) {
      const modelTiming = timing({ headersMs: 0, firstChunkMs: 0, bodyMs: 0, parseMs: 0, firstChunkMeasured: value });
      current = execution({ modelTiming });
      assert.deepEqual((await state()).execution, current);
    }
  });
});

test('web flow/performance: invalid flow enums and counters cannot leak through a valid timing projection', async () => {
  let current = execution();
  await withWeb(() => current, async state => {
    for (const key of ['surface', 'stage', 'verification']) {
      for (const value of [undefined, null, '', secret, 'constructor', '__proto__', 1, {}]) {
        current = execution({ flow: flow({ [key]: value }), modelTiming: timing() });
        const result = await state();
        assert.deepEqual(result.execution, execution({ modelTiming: timing() }), `${key}: ${String(value)}`);
        assert.equal(JSON.stringify(result).includes(secret), false);
      }
    }
    for (const key of ['operations', 'observations']) {
      for (const value of [undefined, null, -1, 0.5, NaN, Infinity, -Infinity, '3', true, Number.MAX_SAFE_INTEGER + 1]) {
        current = execution({ flow: flow({ [key]: value }), modelTiming: timing() });
        assert.deepEqual((await state()).execution, execution({ modelTiming: timing() }), `${key}: ${String(value)}`);
      }
    }
    for (const value of [null, false, 1, secret, []]) {
      current = execution({ flow: value, modelTiming: timing() });
      assert.deepEqual((await state()).execution, execution({ modelTiming: timing() }));
    }
  });
});

test('web flow/performance: all supported flow enums and safe counter boundaries survive projection', async () => {
  let current = execution();
  await withWeb(() => current, async state => {
    for (const [key, values] of Object.entries({
      surface: ['web', 'native', 'visual', 'general'],
      stage: ['prepare', 'observe', 'act', 'verify', 'blocked'],
      verification: ['not_observed', 'observation_available', 'needs_observation'],
      operations: [0, Number.MAX_SAFE_INTEGER], observations: [0, Number.MAX_SAFE_INTEGER],
    })) {
      for (const value of values) {
        current = execution({ flow: flow({ [key]: value }) });
        assert.deepEqual((await state()).execution, current, `${key}: ${value}`);
      }
    }
  });
});

test('web flow/performance: lastOperation accepts only known public tools, not arbitrary identifiers or payloads', async () => {
  let current = execution();
  await withWeb(() => current, async state => {
    for (const lastOperation of ['', 'browser click', 'browser_click({password:"secret"})',
      `https://private.invalid/${secret}`, `Error: ${secret}`, '<script>alert(1)</script>',
      'browser_click\nsecret', 'a'.repeat(101), 'desktop.click:verify-1', 'a'.repeat(100), 'constructor', '__proto__', 123, {}, null]) {
      current = execution({ flow: flow({ lastOperation }) });
      const { lastOperation: _omitted, ...safeFlow } = flow();
      const result = await state();
      assert.deepEqual(result.execution, execution({ flow: safeFlow }));
      assert.equal(JSON.stringify(result).includes(secret), false);
    }
    for (const lastOperation of ['browser_click', 'browser_wait_for', 'desktop_snapshot', 'computer_action_and_screenshot']) {
      current = execution({ flow: flow({ lastOperation }) });
      assert.deepEqual((await state()).execution, current);
    }
  });
});

function frontend() {
  type Element = {
    value: string; textContent: string; hidden: boolean; disabled: boolean; children: Element[];
    className: string; classList: { toggle(): void }; setAttribute(): void; addEventListener(): void;
    append(...nodes: Element[]): void; replaceChildren(...nodes: Element[]): void; scrollIntoView(): void;
  };
  const element = (): Element => ({
    value: '', textContent: '', hidden: false, disabled: false, children: [], className: '',
    classList: { toggle() {} }, setAttribute() {}, addEventListener() {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; }, scrollIntoView() {},
  });
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id)!;
  };
  get('scenario').value = 'auto';
  const source = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
  const api = runInNewContext(source.replace(/void poll\(\);\s*$/, '') + `
    ({ show(value) { state = value; connected = true; renderState(); } });`, {
    document: { getElementById: get, createElement: element, createDocumentFragment: element,
      documentElement: { scrollHeight: 0 } },
    window: { innerHeight: 100, scrollY: 0, confirm: () => true },
    // Deterministic timer stubs: rendering never waits for the platform clock.
    setTimeout() { return 1; }, clearTimeout() {},
    fetch() { throw new Error('frontend fixture must not make network requests'); },
  });
  return {
    get,
    show(value: unknown, extra: Record<string, unknown> = {}) {
      api.show({ token: 'fixture', messages: [], busy: false, closing: false, closed: false,
        execution: value, ...extra });
    },
    showLegacy() {
      api.show({ token: 'fixture', messages: [], busy: false, closing: false, closed: false });
    },
    text() { return [...elements.values()].filter(node => !node.hidden).map(node => node.textContent).join('\n'); },
  };
}

test('frontend flow/performance: old servers, absent execution and missing optional telemetry have safe fallbacks', () => {
  const ui = frontend();
  ui.show(null);
  assert.match(ui.get('execution').textContent, /待运行|暂无执行状态/);
  ui.show(execution());
  assert.match(ui.get('execution').textContent, /总耗时 3\.5 秒/);
  assert.match(ui.get('execution').textContent, /模型 2\.4 秒/);
  assert.doesNotMatch(ui.text(), /NaN|Infinity|undefined|\[object Object\]/);
  ui.show(undefined);
  assert.doesNotMatch(ui.text(), /NaN|Infinity|undefined|\[object Object\]/);
  ui.showLegacy();
  assert.equal(ui.get('scenario').disabled, true);
  assert.doesNotMatch(ui.text(), /NaN|Infinity|undefined|\[object Object\]/);
});

test('frontend flow/performance: flow labels render public enums, never nested recovery or private payloads', () => {
  const ui = frontend();
  ui.show(execution({
    flow: flow({ detail: secret, recovery: { code: secret, message: secret, next: secret } }),
    modelTiming: timing({ response: secret }),
  }));
  assert.match(ui.text(), /流程/);
  assert.match(ui.text(), /验证|核验/);
  assert.match(ui.text(), /browser_click/);
  assert.doesNotMatch(ui.text(), new RegExp(secret));
  for (const [key, values] of Object.entries({
    surface: ['web', 'native', 'visual', 'general'],
    stage: ['prepare', 'observe', 'act', 'verify', 'blocked'],
    verification: ['not_observed', 'observation_available', 'needs_observation'],
  })) {
    for (const value of values) {
      ui.show(execution({ flow: flow({ [key]: value }) }));
      assert.match(ui.text(), /流程/, `${key}: ${value}`);
      assert.doesNotMatch(ui.text(), /NaN|undefined|\[object Object\]|function\s|needs_observation|not_observed|observation_available/);
    }
  }
});

test('frontend flow/performance: unknown and prototype-like enums use fixed fallbacks, not server text', () => {
  const ui = frontend();
  for (const key of ['surface', 'stage', 'verification']) {
    for (const value of [secret, 'constructor', '__proto__', 'toString', null, {}]) {
      ui.show(execution({ flow: flow({ [key]: value }) }));
      assert.doesNotMatch(ui.text(), /flow-performance-secret|function\s|\[object Object\]|undefined|NaN/);
      assert.match(ui.text(), /未知|暂无|未提供|待|不可用|未观测|未观察/);
    }
  }
});

test('frontend flow/performance: invalid optional numbers cannot display NaN, Infinity or coerced counts', () => {
  const ui = frontend();
  const invalid = [NaN, Infinity, -Infinity, -1, '999999999', null, undefined, {}, [], true, Number.MAX_SAFE_INTEGER + 1];
  for (const value of invalid) {
    ui.show(execution({
      elapsedMs: value, modelMs: value, toolMs: value,
      modelRequests: value, toolCalls: value,
      flow: flow({ operations: value, observations: value }),
      modelTiming: timing({ headersMs: value, firstChunkMs: value, bodyMs: value, parseMs: value }),
    }));
    assert.match(ui.get('execution').textContent, /总耗时 0\.0 秒/);
    assert.doesNotMatch(ui.text(), /NaN|Infinity|undefined|\[object Object\]|999999999|9007199254740992|-0\.0|-1/);
  }
  ui.show(execution({ flow: flow({ operations: 0.5, observations: 0.5 }), modelRequests: 0.5, toolCalls: 0.5 }));
  assert.doesNotMatch(ui.text(), /0\.5 次/);
});

test('frontend flow/performance: unmeasured first chunk is distinct from a measured zero and stale telemetry clears', () => {
  const ui = frontend();
  ui.show(execution({ flow: flow(), modelTiming: timing({ firstChunkMeasured: false, firstChunkMs: 0 }) }));
  const unmeasured = ui.text();
  assert.match(unmeasured, /首包|首块|首个.*块/);
  assert.match(unmeasured, /未测|不可测|不可用|未实测/);
  ui.show(execution({ flow: flow(), modelTiming: timing({ firstChunkMeasured: true, firstChunkMs: 0 }) }));
  assert.notEqual(ui.text(), unmeasured);
  ui.show(execution({ modelTiming: timing({ firstChunkMeasured: true, firstChunkMs: 0 }) }));
  assert.doesNotMatch(ui.text(), /browser_click/);
  ui.show(execution());
  assert.doesNotMatch(ui.text(), /browser_click|NaN|Infinity|undefined/);
  ui.show(null);
  assert.match(ui.get('execution').textContent, /待运行|暂无执行状态/);
  assert.doesNotMatch(ui.text(), /browser_click/);
});
