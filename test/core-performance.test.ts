import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../src/core.ts';
import { loadConfig } from '../src/config.ts';
import { BrowserSession } from '../src/browser.ts';

const config = () => loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: 'https://model.invalid/v1' });
const encodedReply = () => Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }));

test('model timing separates response headers, first chunk and body without double-counting', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => {
    now += 7;
    let chunks = 0;
    const bytes = encodedReply();
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        if (chunks === 1) { now += 11; controller.enqueue(bytes.subarray(0, 8)); }
        else if (chunks === 2) { now += 13; controller.enqueue(bytes.subarray(8)); }
        else controller.close();
      },
    }, { highWaterMark: 0 }));
    return response;
  });
  const c = new Conversation(config());
  try {
    assert.equal(await c.send('hello'), 'ok');
    const request = c.timingAudit().requests[0];
    assert.deepEqual(request.timing, { headersMs: 7, firstChunkMs: 18, bodyMs: 24, parseMs: 0, firstChunkMeasured: true });
    assert.equal(request.elapsedMs, 31);
    assert.deepEqual(c.executionState()!.modelTiming, request.timing);
    assert.equal(c.executionState()!.modelMs, 31);
    assert.equal(c.executionState()!.elapsedMs, 31);
    assert.equal(c.executionState()!.flow?.verification, 'not_observed');
  } finally { await c.close(); }
});

test('empty or error model responses do not invent a first chunk measurement', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 502 }));
  const c = new Conversation(config());
  try {
    await assert.rejects(c.send('hello'), /Model HTTP status 502/);
    assert.equal(c.executionState()!.phase, 'failed');
    assert.equal(c.executionState()!.modelTiming!.firstChunkMeasured, false);
    assert.equal(c.timingAudit().requests[0].timing.firstChunkMeasured, false);
    assert.equal(c.timingAudit().requests[0].timing.bodyMs, 0);
  } finally { await c.close(); }
});
test('HTTP failure logs safe diagnostics without provider content or API key', async t => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.join(' ')); });
  const logs: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: {
    code: 'invalid_api_key', message: `authorization Bearer ${secret}`,
  } }), { status: 401, headers: { 'x-request-id': 'request_123' } }));
  const c = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: 'https://model.invalid/v1', HEZUO_CORE_API_KEY: secret }));
  try {
    await assert.rejects(c.send('hello'), /Model HTTP status 401/);
    const output = logs.join('\n');
    assert.match(output, /\"status\":401/);
    assert.match(output, /\"providerCode\":\"invalid_api_key\"/);
    assert.match(output, /\"x-request-id\":\"request_123\"/);
    assert.doesNotMatch(output, /authorization|Bearer|sk-abcdefghijklmnopqrstuvwxyz/);
  } finally { await c.close(); }
});

test('invalid JSON records body receive time and parse failure without response data in audit', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('sensitive unparseable response'));
  const c = new Conversation(config());
  try {
    await assert.rejects(c.send('hello'), /invalid JSON/);
    assert.equal(c.executionState()!.modelTiming!.firstChunkMeasured, true);
    assert.doesNotMatch(JSON.stringify(c.timingAudit()), /sensitive unparseable/);
    assert.equal(c.executionState()!.phase, 'failed');
  } finally { await c.close(); }
});

test('real tool events update flow; an observation is not proof of the business goal', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++requests === 1) return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, tool_calls: [{ id: 'observe', type: 'function', function: { name: 'browser_observe', arguments: '{}' } }],
    } }] }));
    return new Response(encodedReply());
  });
  t.mock.method(BrowserSession.prototype, 'execute', async () => ({ ok: true, text: 'Untrusted page content', detail: { state: { untrusted: true, url: 'https://example.com/', readyState: 'complete' } } }));
  const c = new Conversation(config());
  try {
    await c.send('访问网页');
    const state = c.executionState()!;
    assert.equal(state.flow?.surface, 'web');
    assert.equal(state.flow?.observations, 1);
    assert.equal(state.flow?.verification, 'observation_available');
    assert.equal(state.phase, 'completed');
    assert.doesNotMatch(JSON.stringify(state.flow), /example.com|Untrusted page content/);
  } finally { await c.close(); }
});
