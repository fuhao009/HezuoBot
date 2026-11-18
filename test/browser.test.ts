import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BrowserSession, browserDefinitions } from '../src/browser.ts';

// Isolated document; production startup/networking is covered by routing integration.
test('isolated Chromium document: read, stable IDs, fill, click, scroll, wait, screenshot and close', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<title>Isolated fixture</title><h1>Fixture only</h1>
    <input aria-label="Search" value="PRIVATE_INITIAL_VALUE"><input type="password" aria-label="Password" value="PRIVATE_PASSWORD">
    <textarea>PRIVATE_TEXTAREA</textarea><div hidden>PRIVATE_HIDDEN</div><span style="display:none">PRIVATE_STYLE</span>
    <button onclick="document.querySelector('h1').textContent='Clicked'">Apply</button><div style="height:3000px">Bottom</div>` }));
  const page = await context.newPage();
  await page.goto('https://fixture.example/');
  const session = new BrowserSession({ headless: true });
  // Install an isolated page for action-level assertions.
  Object.assign(session, { browser, context, page, starting: Promise.resolve() });
  const run = (name: string, args = {}) => session.execute(name, JSON.stringify(args));
  try {
    let result = await run('browser_read');
    assert(result.ok);
    assert(result.text.includes('PRIVATE_INITIAL_VALUE'));
    assert(result.text.includes('PRIVATE_PASSWORD'));
    assert(result.text.includes('PRIVATE_TEXTAREA'));
    assert(!result.text.includes('PRIVATE_HIDDEN'));
    assert(!result.text.includes('PRIVATE_STYLE'));
    let snapshot = JSON.parse(result.text);
    const search = snapshot.elements.find((e: { label: string; id: string }) => e.label === 'Search').id;
    assert((await run('browser_fill', { id: search, text: 'hello' })).ok);
    assert.equal(await page.locator('input').first().inputValue(), 'hello');
    assert.equal((await run('browser_click', { id: search })).ok, false, 'stale IDs rejected');
    snapshot = JSON.parse((await run('browser_read')).text);
    const password = snapshot.elements.find((e: { label: string; id: string }) => e.label === 'Password').id;
    assert.equal((await run('browser_fill', { id: password, text: 'synthetic-only' })).ok, true);
    assert.equal(await page.locator('input[type=password]').inputValue(), 'synthetic-only');
    snapshot = JSON.parse((await run('browser_read')).text);
    assert((await run('browser_click', { id: snapshot.elements.find((e: { label: string; id: string }) => e.label === 'Apply').id })).ok);
    assert.match((await run('browser_read')).text, /Clicked/);
    assert((await run('browser_scroll', { pixels: 500 })).ok);
    assert((await run('browser_wait', { milliseconds: 10 })).ok);
    const screenshot = await run('browser_screenshot');
    assert(screenshot.ok && screenshot.image);
    assert(Buffer.from(screenshot.image, 'base64').length > 100);
    assert.equal((await run('browser_back')).code, 'no-history');
    for (const [name, args] of [['browser_wait', { milliseconds: -1 }], ['browser_scroll', { pixels: 0.1 }], ['browser_read', { js: 'process.env' }], ['browser_fill', { id: 'css=input', text: 'x' }], ['shell', {}]] as const) {
      assert.equal((await run(name, args)).ok, false);
    }
  } finally { await session.close(); await session.close(); }
  assert.equal(browser.isConnected(), false);
  assert.equal((await run('browser_read')).ok, false);
});

test('invalid URL syntax and unsupported protocols fail before launch', async () => {
  const session = new BrowserSession({ headless: true });
  try {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'ftp://host/', 'https://', 'http://host:99999/']) {
      assert.equal((await session.execute('browser_open', JSON.stringify({ url }))).ok, false);
    }
    assert.equal(Reflect.get(session, 'browser'), undefined);
  } finally { await session.close(); }
});

test('production browser startup/close race is terminal and idempotent', async () => {
  const session = new BrowserSession({ headless: true });
  const action = session.execute('browser_wait', '{"milliseconds":5}');
  const second = await session.execute('browser_read', '{}');
  assert.equal(second.ok, false);
  await Promise.all([session.close(), session.close(), action]);
  assert.equal((await session.execute('browser_read', '{}')).ok, false);
});

test('schemas and argument parsing have no application length, scroll or wait caps', async () => {
  const session = new BrowserSession();
  const parse = Reflect.get(session, 'args').bind(session);
  const long = 'x'.repeat(20000);
  assert.equal(parse('browser_fill', JSON.stringify({ id: 'e1-1', text: long })).text, long);
  assert.equal(parse('browser_open', JSON.stringify({ url: `http://localhost:8080/?q=${long}` })).url.length > 2048, true);
  assert.equal(parse('browser_scroll', '{"pixels":-100000}').pixels, -100000);
  assert.equal(parse('browser_wait', '{"milliseconds":100000}').milliseconds, 100000);
  const definitions = JSON.stringify(browserDefinitions);
  assert(!definitions.includes('maxLength'));
  assert(!definitions.includes('maximum'));
  await session.close();
});

test('large screenshots, long waits and large scrolls are delegated without application caps', async () => {
  const session = new BrowserSession();
  const calls: unknown[] = [];
  const image = Buffer.alloc(250_001);
  const page = {
    url: () => 'http://localhost:8080/',
    screenshot: async (options: unknown) => { calls.push(options); return image; },
    waitForTimeout: async (milliseconds: number) => { calls.push(milliseconds); },
    mouse: { wheel: async (_x: number, pixels: number) => { calls.push(pixels); } },
  };
  Object.assign(session, { page, starting: Promise.resolve() });
  try {
    const screenshot = await session.execute('browser_screenshot', '{}');
    assert(screenshot.ok && screenshot.image);
    assert.equal(Buffer.from(screenshot.image, 'base64').length, image.length);
    assert.deepEqual(calls[0], { type: 'jpeg', quality: 55, timeout: 0, fullPage: false });
    assert((await session.execute('browser_wait', '{"milliseconds":100000}')).ok);
    assert((await session.execute('browser_scroll', '{"pixels":-100000}')).ok);
    assert.deepEqual(calls.slice(1), [100000, -100000]);
  } finally { await session.close(); }
});
