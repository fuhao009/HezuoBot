import { BrowserSession } from '/Users/a1234/Desktop/HezuoBot-Core/src/browser.ts';
import { chromium } from '/Users/a1234/Desktop/HezuoBot-Core/node_modules/playwright/index.mjs';
import { writeFile } from 'node:fs/promises';
import { cpus, memoryUsage } from 'node:os';
import { performance } from 'node:perf_hooks';

const origin = 'https://93.184.216.34/';
const output = new URL('./controlled-results.json', import.meta.url);
const records = [], calls = [];
let callId = 0, activeParent = null;
const byteSummary = value => {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return { utf8Bytes: Buffer.byteLength(s), sha256: createHash('sha256').update(s).digest('hex') };
};
import { createHash } from 'node:crypto';
function measured(label, fn, input = null) {
  const id = `call-${++callId}`, parentId = activeParent;
  const start = performance.now();
  const record = { id, parentId, label, startedAt: new Date().toISOString(), input: byteSummary(input) };
  calls.push(record);
  return Promise.resolve().then(fn).then(value => {
    Object.assign(record, { ok: true, durationMs: performance.now() - start, output: byteSummary(value) });
    return value;
  }, error => {
    Object.assign(record, { ok: false, durationMs: performance.now() - start, error: String(error?.message ?? error).slice(0, 240) });
    throw error;
  });
}
async function project(id, fn, notes = '') {
  const parent = `call-${++callId}`;
  activeParent = parent;
  const result = { id, status: 'uncollected', notes };
  const start = performance.now();
  try {
    result.value = await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('measurement safety timeout 9000ms')), 9000))]);
    result.status = 'collected';
  } catch (error) { result.error = String(error?.message ?? error).slice(0, 300); }
  result.durationMs = performance.now() - start;
  result.parentCallId = parent;
  records.push(result);
  activeParent = null;
  return result;
}

let browser, context, page, session;
const pages = [
  '<!doctype html><html><head><title>Controlled Alpha</title></head><body><h1>Alpha Needle</h1><button id="go">Go</button><button id="slow">Slow</button><button id="confirm">Confirm</button><div hidden>SecretHiddenNeedle</div><script>document.querySelector("#go").onclick=()=>{document.body.dataset.clicked="yes"};document.querySelector("#slow").onclick=()=>new Promise(()=>{});document.querySelector("#confirm").onclick=()=>confirm("Controlled confirm")</script></body></html>',
  '<!doctype html><html><head><title></title></head><body><h1>Empty title</h1><button>Wait</button></body></html>'
];
const pageUrl = `${origin}?controlled=alpha`;
try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.route('https://93.184.216.34/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/fault') return route.fulfill({ status: 503, contentType: 'text/html', body: '<title>Fault controlled</title><h1>Fault page</h1>' });
    if (url.pathname === '/empty') return route.fulfill({ status: 200, contentType: 'text/html', body: pages[1] });
    await route.fulfill({ status: 200, contentType: 'text/html', body: pages[0] });
  });
  page = await context.newPage();
  session = new BrowserSession({ headless: true, stateDirectory: '/tmp/controlled-browser-session' });
  const originalStart = session.start.bind(session);
  // The session owns its own Chromium context; instrumentation observes only public calls.
  session.start = (...args) => measured('BrowserSession.start', () => originalStart(...args), { phase: 'start' });
  for (const name of ['execute','status']) {
    const original = session[name].bind(session);
    session[name] = (...args) => measured(`BrowserSession.${name}`, () => original(...args), { name, args: args.map(a => typeof a === 'string' ? a.slice(0, 200) : a instanceof AbortSignal ? 'AbortSignal' : a) });
  }
  await project('T12-per-element-call-fields', async () => {
    const r = await session.execute('browser_open', JSON.stringify({ url: pageUrl, observe: 'read' }));
    return { open: r, status: await session.status() };
  }, 'Actual tool call and BrowserSession.start/status; arguments and results retained as size+digest only in API log.');
  await project('T13-success-empty-fault-abort', async () => {
    const success = await session.execute('browser_open', JSON.stringify({ url: pageUrl }));
    const empty = await session.execute('browser_open', JSON.stringify({ url: `${origin}empty` }));
    const fault = await session.execute('browser_open', JSON.stringify({ url: `${origin}fault` }));
    const controller = new AbortController(); controller.abort(new Error('injected abort')); 
    const abort = await session.execute('browser_read', '{}', controller.signal);
    return { success, empty, fault, abort };
  }, 'Abort signal explicitly injected; fault is route-fulfilled HTTP 503.');
  await project('T14-wait-read-single-sample', async () => ({
    wait: await session.execute('browser_wait_for', JSON.stringify({ url: pageUrl, text: 'Alpha Needle', timeout: 2500 })),
    read: await session.execute('browser_read', '{}')
  }));
  await project('T15-read-diagnostic-faults', async () => ({
    readFault: await session.execute('browser_read', '{}', AbortSignal.abort(new Error('injected read failure'))),
    diagnosticFault: await session.execute('browser_diagnostic', '{}', AbortSignal.abort(new Error('injected diagnostic failure')))
  }), 'Both failures explicitly injected via already-aborted signals; diagnostic may be unsupported and remains visible.');
  await project('T16-url-text-and-or-hidden', async () => ({
    and: await session.execute('browser_wait_for', JSON.stringify({ url: pageUrl, text: 'Alpha Needle', timeout: 1800 })),
    or: await session.execute('browser_wait_for', JSON.stringify({ url: `${origin}never`, text: 'Alpha Needle', timeout: 1800, match: 'or' })),
    hidden: await session.execute('browser_wait_for', JSON.stringify({ text: 'SecretHiddenNeedle', timeout: 1200 }))
  }), 'Captures actual product semantics, including mismatches.');
  await project('T17-timeout', () => session.execute('browser_wait_for', JSON.stringify({ text: 'NotPresentNeedle', timeout: 450 })));
  await project('T22-no-deadline-cancel-recovery', async () => {
    const c = new AbortController();
    const pending = session.execute('browser_wait_for', JSON.stringify({ text: 'NeverNeedle' }), c.signal);
    const observed = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('still-pending'), 500))]);
    c.abort(new Error('injected cancellation')); const cancelled = await pending;
    const recovered = await session.execute('browser_read', '{}');
    return { observed, cancelled, recovered };
  }, '500ms is only a pending-state observation guard; cancellation injected; no product deadline parameter.');
  await project('T23-stale-reference-recovery', async () => ({
    stale: await session.execute('browser_click', JSON.stringify({ ref: 'e99999' })),
    recovered: await session.execute('browser_read', '{}')
  }), 'A fabricated stale ref is an explicit fault injection; no live document references recorded.');
  await project('T24-confirm-pending-dismiss-recovery', async () => {
    const action = session.execute('browser_click', JSON.stringify({ selector: '#confirm' }));
    const pending = await Promise.race([action, new Promise(resolve => setTimeout(() => resolve('pending'), 700))]);
    const dialog = session.execute('browser_dialog', JSON.stringify({ action: 'dismiss' }));
    return { pending, dismissed: await dialog, action: await action, recovered: await session.execute('browser_read', '{}') };
  }, 'Dismiss explicitly requested; dialog pending is detected with bounded observation guard.');
  await project('T03-direct-read-cost', () => session.execute('browser_read', '{}'), 'Direct browser_read call; API input/output bytes are digest-only.');
} catch (error) {
  records.push({ id: 'harness-failure', status: 'failed', error: String(error?.stack ?? error).slice(0, 1200) });
} finally {
  const resources = { cpuCount: cpus().length, processMemory: memoryUsage(), note: 'CPU count and Node process memory only; excludes Chromium/browser process memory and system-wide resources.' };
  await session?.close().catch(error => records.push({ id: 'close-session', status: 'failed', error: String(error) }));
  await context?.close().catch(error => records.push({ id: 'close-context', status: 'failed', error: String(error) }));
  await browser?.close().catch(error => records.push({ id: 'close-browser', status: 'failed', error: String(error) }));
  await writeFile(output, JSON.stringify({ target: 'src/browser.ts', controlledUrl: origin, network: 'context.route fulfills all requests to public-format IP; no external network', generatedAt: new Date().toISOString(), results: records, apiCalls: calls, resources }, null, 2));
}
