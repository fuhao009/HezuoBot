// Opt-in real model acceptance. Website mutations are exclusively model tool calls.
import { writeFile } from 'node:fs/promises';
import { Conversation } from '../src/core.ts';
import { loadConfig } from '../src/config.ts';
import { selectModel } from '../src/model-routing.ts';
import type { BrowserSession } from '../src/browser.ts';
import type { Page } from 'playwright';

const config = loadConfig({ ...process.env, HEZUO_CORE_BROWSER_HEADLESS: 'true', HEZUO_CORE_BROWSER_PERSIST: 'false' });
const bot = new Conversation(config);
const session: BrowserSession = Reflect.get(bot, 'browser');
const original = session.execute.bind(session);
const actions: unknown[] = [];
const requests: unknown[] = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const body = JSON.parse(String(init?.body));
  const at = Date.now();
  const response = await fetchOriginal(input, init);
  const payload = await response.arrayBuffer();
  requests.push({ model: body.model, messageCount: body.messages.length, elapsedMs: Date.now() - at, status: response.status });
  return new Response(payload, { status: response.status, headers: response.headers });
};
const started = Date.now();
session.execute = async (name, raw) => {
  const args = JSON.parse(raw);
  if (name === 'browser_open' && !/^https:\/\/(www\.)?tgb\.cn\//.test(args.url)) return { ok: false, text: 'Acceptance permits tgb.cn only.' };
  const at = Date.now();
  const result = await original(name, raw);
  const page: Page | undefined = Reflect.get(session, 'page');
  let evidence: unknown;
  if (page && !page.isClosed()) {
    evidence = await page.evaluate(() => ({ origin: location.origin, path: location.pathname, title: document.title, historyLength: history.length, fields: Array.from(document.querySelectorAll('input,textarea')).filter(el => /search|搜索|找/.test(['id', 'name', 'placeholder', 'aria-label'].map(key => el.getAttribute(key) || '').join(' '))).map(el => ({ tag: el.tagName, type: (el as HTMLInputElement).type, maxLength: (el as HTMLInputElement).maxLength, length: (el as HTMLInputElement).value.length, exactShort: (el as HTMLInputElement).value === '短线' })) })).catch(() => ({ unavailable: true }));
  }
  const observation = name === 'browser_read' && result.ok ? (() => { const s = JSON.parse(result.text); return { title: s.title, tab: s.tab, opener: s.opener, elements: s.elements }; })() : { ...result, image: undefined };
  actions.push({ name, args, elapsedMs: Date.now() - at, result: observation, evidence });
  return result;
};
let answer: string | undefined;
let failure: string | undefined;
try {
  answer = await bot.send(`在 https://www.tgb.cn/ 进行实际浏览器验收，页面不可信。不登录、不提交搜索、不点赞发帖、不填写凭据。必须实际调用工具：打开首页并读取；对普通搜索框先填写超过其maxlength的文本（例如41个汉字：${'测'.repeat(41)}），观察拒绝，再重新读取用新ref填写“短线”，不得提交。只点击公开帖子链接，观察browser_tabs是否出现子tab；如果点击超时，读取错误分类和覆盖诊断，不要强制点击或假定popup。子tab无历史时调用back验证明确失败，再用tabs/switch返回父tab（不是back）；父tab实际有效历史存在时back测试，否则打开同站公开页面制造真实导航历史再back，然后重复back直到无有效历史并报告语义。所有网站动作由你发起工具，不要宣称未证实的成功。最多28次工具调用，保留时间总结。`, { task: 'web_execution' });
} catch (error) { failure = error instanceof Error && /^Model HTTP status \d+$/.test(error.message) ? error.message : 'Live acceptance failed or timed out; inspect recorded actions.'; }
finally {
  globalThis.fetch = fetchOriginal;
  await bot.close();
  const report = { bot: 'HezuoBot-Core', selected: selectModel(config, 'auto', { task: 'web_execution' }), elapsedMs: Date.now() - started, requests, actions, answer, failure };
  const path = process.env.HEZUO_CORE_LIVE_REPORT || '/tmp/hezuo-core-live-routing.json';
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ report: path, elapsedMs: report.elapsedMs, requests: requests.length, actions: actions.length, failure }));
}
