import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import type { Duplex } from 'node:stream';
import { BrowserSession } from '../src/browser.ts';
import { Conversation } from '../src/core.ts';
import { loadConfig } from '../src/config.ts';
import { classifyBrowserError } from '../src/browser-errors.ts';

test('native UTF16 constraints, exact verification, mismatch, click, popup and history', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<input aria-label="Search" maxlength="4" value="keep"><input aria-label="Rewrite" oninput="this.value='altered'"><button id="covered" style="position:absolute;left:10px;top:80px">Covered</button><div style="position:absolute;left:0;top:60px;width:300px;height:100px;z-index:99">Overlay</div><a href="https://93.184.216.34/post" target="_blank">Post</a>` }));
  const page = await context.newPage();
  await page.goto('https://93.184.216.34/');
  const session = new BrowserSession({ headless: true });
  Object.assign(session, { browser, context, page, starting: Promise.resolve() });
  Reflect.get(session, 'trackPage').call(session, page);
  context.on('page', popup => { const task = Reflect.get(session, 'adoptPopup').call(session, popup); const tasks = Reflect.get(session, 'popupTasks'); tasks.add(task); void task.finally(() => tasks.delete(task)); });
  const run = (name: string, args = {}) => session.execute(name, JSON.stringify(args));
  async function field(label: string) { const snapshot = JSON.parse((await run('browser_read')).text); return snapshot.elements.find((element: { label: string }) => element.label === label); }
  try {
    const search = await field('Search');
    assert.equal(search.constraints.maxLength, 4);
    await page.locator('input').first().fill('😀😀a');
    const nativeValue = await page.locator('input').first().inputValue();
    await page.locator('input').first().fill('keep');
    const result = await run('browser_fill', { id: search.id, text: '😀😀a' });
    assert.equal(result.code, nativeValue === '😀😀a' ? 'filled' : 'value-mismatch');
    assert.equal(result.detail?.requestedLength, 5);
    assert.equal(await page.locator('input').first().inputValue(), nativeValue);
    assert(!JSON.stringify(result).includes('keep'));
    const filled = await run('browser_fill', { id: (await field('Search')).id, text: '😀ab' });
    assert.equal(filled.code, 'filled');
    assert.equal(await page.locator('input').first().inputValue(), '😀ab');
    assert.equal((await run('browser_fill', { id: (await field('Rewrite')).id, text: 'test' })).code, 'value-mismatch');
    // Remove the covering fixture explicitly; no timeout is needed for the click.
    await page.locator('#covered + div').evaluate(el => el.remove());
    const covered = await run('browser_click', { id: (await field('Covered')).id });
    assert.equal(covered.ok, true);
    const old = (await field('Post')).id;
    const popup = page.waitForEvent('popup');
    assert((await run('browser_click', { id: old })).ok);
    const opened = await popup;
    await opened.waitForLoadState();
    await Promise.all([...Reflect.get(session, 'popupTasks')]);
    const tabs = JSON.parse((await run('browser_tabs')).text);
    assert.equal(tabs.tabs.length, 2);
    assert.equal(tabs.active, 't2');
    assert.equal(tabs.tabs[1].opener, 't1');
    assert.equal((await run('browser_click', { id: old })).code, 'stale-ref');
    assert.equal((await run('browser_back')).code, 'no-history');
    assert((await run('browser_switch', { tab: 't1' })).ok);
    assert.equal(Reflect.get(session, 'page'), page);
    await page.goto('https://93.184.216.34/second');
    assert((await run('browser_back')).ok);
    assert.equal(page.url(), 'https://93.184.216.34/');
    assert.equal((await run('browser_back')).code, 'no-history');
  } finally { await session.close(); }
});

test('actual request model is routed without extra classification requests', async () => {
  const models: string[] = [];
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    models.push(JSON.parse(data).model);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }));
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address(); assert(address && typeof address === 'object');
  const config = loadConfig({ HEZUO_CORE_BASE_URL: `http://127.0.0.1:${address.port}/v1`, HEZUO_CORE_MODEL: 'base-fixture', HEZUO_CORE_WEB_MODEL: 'web-fixture' });
  const bot = new Conversation(config);
  try {
    await bot.send('web task', { task: 'web_execution' });
    await bot.send('analysis fallback', { phase: 'planning_analysis' });
    await bot.send('override', { task: 'web_execution' }, 'default');
    await bot.send('no metadata');
    const analysisBot = new Conversation({ ...config, analysisModel: 'analysis-fixture' });
    try { await analysisBot.send('explicit analysis', { phase: 'planning_analysis' }); }
    finally { await analysisBot.close(); }
    assert.deepEqual(models, ['web-fixture', 'base-fixture', 'base-fixture', 'base-fixture', 'analysis-fixture']);
  } finally {
    await bot.close();
    const closing = Promise.withResolvers<void>();
    server.close(() => closing.resolve());
    await closing.promise;
  }
  assert.equal(classifyBrowserError(new Error('Timeout: SECRET_URL intercepts pointer events')), 'covered');
});

test('production session uses native networking for local redirects, frames, popups, WebSockets and service workers', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/home?token=allowed' }); res.end(); return; }
    if (req.url === '/worker.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));");
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url?.startsWith('/home') ? `<title>Local fixture</title><a href="/popup" target="_blank">Popup</a><iframe src="/frame" title="Frame"></iframe><form method="post" action="/submitted"><input name="message"><button>Submit</button></form>` : '<title>Child fixture</title>');
  });
  const upgraded = Promise.withResolvers<void>();
  const upgradedSockets = new Set<Duplex>();
  server.on('upgrade', (_req, socket) => {
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    upgraded.resolve();
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address(); assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const session = new BrowserSession({ headless: true });
  const run = (name: string, args = {}) => session.execute(name, JSON.stringify(args));
  try {
    assert((await run('browser_open', { url: `${origin}/redirect` })).ok);
    const page = Reflect.get(session, 'page') as Page;
    assert.equal(page.url(), `${origin}/home?token=allowed`);
    await page.waitForLoadState('load');
    assert(page.frames().some(frame => frame.url() === `${origin}/frame`));
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/worker.js');
      await navigator.serviceWorker.ready;
    });
    assert.equal(page.context().serviceWorkers().length, 1);
    await page.evaluate(() => { const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/socket'); socket.onerror = () => {}; });
    await upgraded.promise;
    const popup = page.waitForEvent('popup');
    const snapshot = JSON.parse((await run('browser_read')).text);
    const link = snapshot.elements.find((entry: { label: string }) => entry.label === 'Popup');
    assert((await run('browser_click', { id: link.id })).ok);
    const opened = await popup;
    await opened.waitForLoadState();
    await Promise.all([...Reflect.get(session, 'popupTasks')]);
    const tabs = JSON.parse((await run('browser_tabs')).text);
    assert.equal(tabs.tabs.length, 2);
    assert((await run('browser_switch', { tab: 't1' })).ok);
    assert((await run('browser_open', { url: `${origin}/another` })).ok);
    assert((await run('browser_back')).ok);
    assert.equal(page.url(), `${origin}/home?token=allowed`);
    await page.locator('input').fill('synthetic');
    const submitted = page.waitForURL('**/submitted');
    const controls = JSON.parse((await run('browser_read')).text);
    const submit = controls.elements.find((entry: { label: string }) => entry.label === 'Submit');
    assert((await run('browser_click', { id: submit.id })).ok);
    await submitted;
    assert.equal(page.url(), `${origin}/submitted`);
  } finally {
    await session.close();
    for (const socket of upgradedSockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    server.closeAllConnections();
    await closed.promise;
  }
});
