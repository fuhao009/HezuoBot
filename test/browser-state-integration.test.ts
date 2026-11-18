import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BrowserSession } from '../src/browser.ts';
import { BrowserStateStore } from '../src/browser-state.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tgbFields } from '../src/tgb-login.ts';

test('isolated real Chromium: tab discovery, fixed field validation, save/restart/restore/clear, open/back and resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-browser-'));
  const directory = join(root, 'state');
  const store = new BrowserStateStore(directory);
  const browser = await chromium.launch({ headless: true });
  const longText = 'Fixture text '.repeat(2000);
  // UTF-8 snapshot exceeds 4MiB while UTF-16 storage stays within Chromium's site quota.
  const largeState = '界'.repeat(2 * 1024 * 1024 + 1);
  const markup = `<title>${'Title'.repeat(60)}</title><nav style="position:fixed;top:0;width:100%;height:50px">${Array.from({ length: 350 }, (_, i) => `<a href="#${i}">nav${i}</a>`).join('')}</nav><div style="height:3000px">${longText}</div>
    <span style="display:none" onclick="">hidden</span><div role="dialog" style="position:fixed;top:150px;left:100px;width:400px;height:300px;z-index:999;background:white">
    <span id="accountTab" style="cursor:pointer">账号登录</span>
    <div id="panel" hidden><input id="userPanelName" type="text"><input id="userPanelPwd" type="password"><button id="loginBtn">登录</button></div></div>
    <script>document.querySelector('#accountTab').addEventListener('click',()=>document.querySelector('#panel').hidden=false)</script>`;
  let context = await browser.newContext();
  const routeContext = async () => context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: markup }));
  await routeContext();
  let page = await context.newPage();
  await page.goto('https://www.tgb.cn/');
  const session = new BrowserSession({ headless: true, stateDirectory: directory });
  Object.assign(session, { browser, context, page, starting: Promise.resolve() });
  try {
    const read = await session.execute('browser_read', '{}'); assert.ok(read.ok);
    const snapshot: { elements: { label: string; id: string }[]; elementsTruncated: boolean; text: string; title: string } = JSON.parse(read.text);
    assert.equal(snapshot.elementsTruncated, false);
    assert(snapshot.elements.length > 100);
    assert(snapshot.elements.some(e => e.label === 'nav349'));
    assert.equal(snapshot.text.includes(longText.trim()), true);
    assert.equal(snapshot.title.length, 300);
    const tab = snapshot.elements.find(e => e.label === '账号登录'); assert.ok(tab, JSON.stringify(snapshot));
    assert.equal(snapshot.elements.some(e => e.label === 'hidden'), false);
    assert.ok((await session.execute('browser_click', JSON.stringify({ id: tab.id }))).ok);
    await tgbFields(page);
    await page.locator('#userPanelPwd').evaluate(el => el.setAttribute('type', 'text'));
    await assert.rejects(tgbFields(page));
    await page.locator('#userPanelPwd').evaluate(el => el.setAttribute('type', 'password'));
    await context.addCookies([{ name: 'fixture', value: 'synthetic-only', domain: 'www.tgb.cn', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    await page.evaluate(value => localStorage.setItem('fixture', value), largeState);
    assert.ok((await session.saveState()).ok);
    await context.close();
    const restored = await store.load(); assert.ok(restored.state);
    context = await browser.newContext({ storageState: restored.state });
    await routeContext(); page = await context.newPage(); await page.goto('https://www.tgb.cn/');
    Object.assign(session, { context, page });
    assert.equal((await context.cookies()).find(c => c.name === 'fixture')?.value, 'synthetic-only');
    assert.equal(await page.evaluate(() => localStorage.getItem('fixture')), largeState);
    assert.ok((await session.execute('browser_open', '{"url":"https://example.com/"}')).ok);
    assert.ok((await session.execute('browser_back', '{}')).ok);
    assert.equal(page.url(), 'https://www.tgb.cn/');
    await page.locator('#accountTab').click();
    await page.locator('#userPanelPwd').fill('synthetic-password');
    const credentialRead = await session.execute('browser_read', '{}');
    assert.equal(credentialRead.ok, true);
    assert(credentialRead.text.includes('synthetic-password'));
    assert.ok((await session.resumeAccess()).ok);
    assert.equal(await page.locator('#userPanelPwd').inputValue(), '');
    assert.ok((await session.execute('browser_read', '{}')).ok);
    assert.ok((await session.clearState()).ok);
    assert.equal((await store.load()).state, undefined);
    await session.close();
    assert.equal((await store.load()).state, undefined);
  } finally { await session.close(); await browser.close(); await rm(root, { recursive: true, force: true }); }
});
