import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { localTgbLogin, validTgbUrl, tgbLoginDefinition } from '../src/tgb-login.ts';
import { BrowserSession } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';
import { Conversation } from '../src/core.ts';
import { createServer } from 'node:http';

const signal = () => new AbortController().signal;
function pageFixture() {
  const state = { url: 'https://www.tgb.cn/', checks: 0, fills: 0, clicks: 0, valid: true };
  const page = { url: () => state.url, evaluate: async (_fn: unknown, args: { credentials?: unknown }) => {
    state.checks++; if (args.credentials) state.fills++; return state.valid;
  }, locator: (selector: string) => { assert.equal(selector, '#loginBtn'); return { click: async () => { state.clicks++; } }; } } as unknown as Page;
  return { state, page };
}

test('HTTP URL validity and empty model contract do not restrict the login site', () => {
  for (const url of ['https://www.tgb.cn/login', 'http://localhost/login', 'https://example.org', 'https://www.tgb.cn:444']) assert.ok(validTgbUrl(url));
  for (const url of ['not a URL', 'file:///tmp/login', 'https://u:p@example.org']) assert.equal(validTgbUrl(url), false);
  assert.deepEqual(tgbLoginDefinition.function.parameters.properties, {});
  assert.ok(loadConfig({ HEZUO_CORE_MODEL: 'fixture', HEZUO_CORE_BASE_URL: 'http://localhost', HEZUO_CORE_TOOLS: 'tgb_login_local' }).tools.includes('tgb_login_local'));
});

test('local fill and submit need no confirmation or browser-access lock; result contains no credentials', async () => {
  const { state, page } = pageFixture(); let locked = false;
  const credentials = { account: 'isolated-account', password: 'isolated-fake-secret' };
  const result = await localTgbLogin(page, { collect: async () => credentials, confirm: async () => { assert.fail('confirmation must not be requested'); } }, signal(), () => { locked = true; });
  assert.ok(result.ok); assert.equal(locked, false); assert.equal(state.fills, 1); assert.equal(state.clicks, 1);
  assert.equal(credentials.password, ''); assert.doesNotMatch(JSON.stringify(result), /isolated-/);
  assert.match(result.text, /NOT proof of login/);
});

test('cancel, changed structure and explicit abort never submit', async () => {
  for (const mode of ['cancel', 'structure', 'abort']) {
    const { state, page } = pageFixture(); const abort = new AbortController();
    const result = await localTgbLogin(page, { collect: async () => {
      if (mode === 'cancel') return null;
      if (mode === 'structure') state.valid = false;
      if (mode === 'abort') abort.abort();
      return { account: 'fake', password: 'fake' };
    }, confirm: async () => { assert.fail('confirmation must not be requested'); } }, abort.signal, () => {});
    assert.equal(result.ok, false); assert.equal(state.clicks, 0);
  }
});

test('a different current login origin does not block filling', async () => {
  const { state, page } = pageFixture();
  state.url = 'https://example.org/login';
  const result = await localTgbLogin(page, { collect: async () => ({ account: 'fake', password: 'fake' }), confirm: async () => false }, signal(), () => {});
  assert.equal(result.ok, true);
  assert.equal(state.clicks, 1);
});

test('failure redacts raw page errors', async () => {
  const { page } = pageFixture();
  page.evaluate = async () => { throw new Error('fake-secret-in-error'); };
  const result = await localTgbLogin(page, { collect: async () => { throw Error('not called'); }, confirm: async () => true }, signal(), () => {});
  assert.equal(result.ok, false); assert.doesNotMatch(result.text, /fake-secret/);
});

test('model targets and noninteractive calls rejected without browser startup', async () => {
  const browser = new BrowserSession();
  try {
    for (const raw of ['{"url":"https://evil.test"}', '""', '1', '[]', 'null', '{"password":"fake"}']) assert.equal((await browser.loginLocal(raw, undefined, signal())).ok, false);
    assert.match((await browser.loginLocal('{}', undefined, signal())).text, /TTY/);
  } finally { await browser.close(); }
});

test('conversation advertises and dispatches login but never requests terminal input without TTY dependency', async () => {
  const bodies: { tools: { function: { name: string } }[]; messages: { role: string; content: string }[] }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw)); res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop', message: bodies.length === 1 ? {
      role: 'assistant', content: null, tool_calls: [{ id: 'local', type: 'function', function: { name: 'tgb_login_local', arguments: '{}' } }],
    } : { role: 'assistant', content: 'Terminal required; no login claimed.' } }] }));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address() as { port: number };
  const conversation = new Conversation(loadConfig({ HEZUO_CORE_MODEL: 'isolated-fixture', HEZUO_CORE_BASE_URL: `http://127.0.0.1:${address.port}`, HEZUO_CORE_TOOLS: 'tgb_login_local' }));
  try {
    assert.match(await conversation.send('打开 tgb.cn 帮我登录'), /Terminal required/);
    assert.ok(bodies[0].tools.some(tool => tool.function.name === 'tgb_login_local'));
    assert.match(bodies[1].messages.find(m => m.role === 'tool')!.content, /TTY/);
    assert.doesNotMatch(JSON.stringify(bodies), /isolated-fake-secret/);
  } finally { await conversation.close(); const closing = Promise.withResolvers<void>(); server.close(() => closing.resolve()); await closing.promise; }
});
