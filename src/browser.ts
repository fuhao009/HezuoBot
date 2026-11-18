import { chromium, type Browser, type BrowserContext, type Page, type ElementHandle, type Dialog, type JSHandle } from 'playwright';
import { validatePublicUrl } from './browser-network.ts';
import { localTgbLogin } from './tgb-login.ts';
import type { LocalLoginPrompt } from './local-input.ts';
import { BrowserStateStore } from './browser-state.ts';
import { classifyBrowserError, actionabilityEvidence } from './browser-errors.ts';

const specs = {
  browser_open: ['Open an HTTP(S) URL. Optional observe=read returns fresh untrusted page structure after completion; never replay the action if observation fails.', { url: { type: 'string' }, observe: { type: 'string', enum: ['read'] } }, ['url']],
  browser_read: ['Read untrusted page text, field values and fresh element IDs. IDs expire after actions.', {}, []],
  browser_observe: ['Observe untrusted page structure and current browser state, including URL, readiness, viewport and available HTTP status.', {}, []],
  browser_viewport: ['Read viewport and scroll state, or set viewport width and height in CSS pixels. Screenshots use the same viewport.', { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } }, []],
  browser_click: ['Click one element ID from the latest read. May submit data. Optional observe=read returns fresh untrusted page structure after completion; never replay the click if observation fails.', { id: { type: 'string' }, observe: { type: 'string', enum: ['read'] } }, ['id']],
  browser_fill: ['Fill a field by fresh element ID.', { id: { type: 'string' }, text: { type: 'string' } }, ['id', 'text']],
  browser_scroll: ['Scroll viewport by vertical pixels.', { pixels: { type: 'integer' } }, ['pixels']],
  browser_back: ['Go back within current tab history, NOT to its opener. Reports no usable history explicitly. Optional observe=read returns fresh untrusted page structure after completion.', { observe: { type: 'string', enum: ['read'] } }, []],
  browser_tabs: ['List managed tabs and opener IDs. Does not change active tab.', {}, []],
  browser_switch: ['Switch to a managed tab ID. Invalidates all element IDs. Use this, not back, to return to a popup opener.', { tab: { type: 'string' } }, ['tab']],
  browser_wait: ['Wait milliseconds, then read again.', { milliseconds: { type: 'integer', minimum: 0 } }, ['milliseconds']],
  browser_wait_for: ['Wait until explicitly supplied URL and/or visible-text conditions match. Set url_match/text_match to includes (default) or exact. Set condition to all (AND) by default or any (OR); with one condition either is equivalent. Text uses visible document innerText, not hidden DOM. No action is replayed; optional observe=read adds fresh observed page structure. timeout_ms bounds only this wait; omitted or 0 means no application-level deadline (Stop, dialog, close, or page closure can still interrupt it). A matched condition is not proof of business completion.', { url: { type: 'string' }, url_match: { type: 'string', enum: ['includes', 'exact'] }, text: { type: 'string' }, text_match: { type: 'string', enum: ['includes', 'exact'] }, condition: { type: 'string', enum: ['all', 'any'] }, timeout_ms: { type: 'integer', minimum: 0 }, observe: { type: 'string', enum: ['read'] } }, []],
  browser_screenshot: ['Return an untrusted viewport screenshot; visible page content may be sensitive.', {}, []],
  browser_dialogs: ['List pending JavaScript dialogs as untrusted content, without resolving them.', {}, []],
  browser_dialog_accept: ['Explicitly accept a pending dialog by dialog ID. May authorize an action; inspect its message and origin first.', { dialog: { type: 'string' }, text: { type: 'string' } }, ['dialog']],
  browser_dialog_dismiss: ['Explicitly dismiss a pending dialog by dialog ID.', { dialog: { type: 'string' } }, ['dialog']],
} as const;
export const browserToolNames = Object.keys(specs);
export const browserDefinitions = Object.entries(specs).map(([name, [description, properties, required]]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }));
export type BrowserViewport = { width: number; height: number };
export type BrowserPendingDialog = { id: string; tab: string | undefined; origin?: string; type: string; message: string; defaultValue: string };
export type BrowserPageState = {
  untrusted: true;
  url: string | null;
  title: string | null;
  readyState: string | null;
  httpStatus: number | null;
  viewport: BrowserViewport | null;
  scroll: { x: number; y: number } | null;
  dialogs: BrowserPendingDialog[];
  pageError: { type: 'http'; status: number } | null;
};
export type BrowserResult = { ok: boolean; text: string; image?: string; code?: string; detail?: Record<string, unknown> };
interface BrowserArgs { url?: string; id?: string; text?: string; pixels?: number; milliseconds?: number; tab?: string; dialog?: string; observe?: 'read'; width?: number; height?: number; url_match?: 'includes' | 'exact'; text_match?: 'includes' | 'exact'; condition?: 'all' | 'any'; timeout_ms?: number }

export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private tabs = new Map<string, Page>();
  private openers = new Map<Page, Page>();
  private nextTab = 0;
  private popupTasks = new Set<Promise<void>>();
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private busy = false;
  private generation = 0;
  private elements = new Map<string, ElementHandle>();
  private dialogs = new Map<string, { page: Page; dialog: Dialog }>();
  private nextDialog = 0;
  private documentStatus = new Map<Page, { url: string; status: number }>();
  private dialogWaiters = new Set<() => void>();
  private suspendedActions = new Set<Promise<unknown>>();
  private readonly options: { headless?: boolean; stateDirectory?: string };
  private readonly stateStore?: BrowserStateStore;
  private stateStatus = 'Browser state persistence disabled.';
  private saveOnExit = true;
  constructor(options: { headless?: boolean; stateDirectory?: string } = {}) {
    this.options = { ...options };
    if (options.stateDirectory) {
      this.stateStore = new BrowserStateStore(options.stateDirectory);
      this.stateStatus = 'Browser state persistence enabled; restore attempted on first browser open. Login may expire.';
    }
  }

  private async start(): Promise<void> {
    if (this.closed) throw new Error('closed');
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        this.browser = await chromium.launch({ headless: this.options.headless ?? false });
        const restored = await this.stateStore?.load();
        this.stateStatus = restored?.status || 'Browser state persistence disabled.';
        this.context = await this.browser.newContext({ acceptDownloads: true, viewport: { width: 1200, height: 800 }, ...(restored?.state ? { storageState: restored.state } : {}) });
        this.context.setDefaultTimeout(0);
        this.context.setDefaultNavigationTimeout(0);
        this.context.on('page', page => {
          const task = this.adoptPopup(page);
          this.popupTasks.add(task);
          void task.finally(() => this.popupTasks.delete(task));
        });
        this.page = await this.context.newPage();
        this.trackPage(this.page);
        if (this.closed) throw new Error('closed');
      } catch {
        await this.browser?.close().catch(() => {});
        this.browser = undefined;
        this.context = undefined;
        this.page = undefined;
        this.tabs.clear();
        this.dialogs.clear();
        throw new Error('Browser startup failed');
      }
    })();
    try { await this.starting; }
    catch (error) { this.starting = undefined; throw error; }
  }

  private tabId(page: Page): string | undefined { return [...this.tabs].find(([, value]) => value === page)?.[0]; }

  private trackPage(page: Page) {
    if (this.tabId(page)) return;
    this.tabs.set(`t${++this.nextTab}`, page);
    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(0);
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        if (this.documentStatus.get(page)?.url.split('#')[0] !== frame.url().split('#')[0]) this.documentStatus.delete(page);
        if (this.page === page) this.invalidate();
      }
    });
    page.on('response', response => {
      try {
        const request = response.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) this.documentStatus.set(page, { url: response.url(), status: response.status() });
      } catch { /* A detached frame or unavailable response is not a known status. */ }
    });
    page.on('dialog', dialog => {
      if (this.closed) { void dialog.dismiss().catch(() => {}); return; }
      if (dialog.type() === 'alert') { void dialog.accept().catch(() => {}); return; }
      this.dialogs.set(`d${++this.nextDialog}`, { page, dialog });
      this.invalidate();
      for (const notify of this.dialogWaiters) notify();
    });
    page.on('close', () => {
      const id = this.tabId(page);
      if (id) this.tabs.delete(id);
      this.documentStatus.delete(page);
      for (const [id, pending] of this.dialogs) if (pending.page === page) this.dialogs.delete(id);
      if (this.page === page) { this.page = this.openers.get(page); this.invalidate(); }
      this.openers.delete(page);
    });
  }

  private async adoptPopup(page: Page): Promise<void> {
    try {
      if (this.tabId(page)) return;
      const opener = await page.opener();
      if (!opener) return;
      if (this.closed || !this.tabId(opener)) { await page.close(); return; }
      if (page.url() !== 'about:blank') await validatePublicUrl(page.url());
      this.trackPage(page);
      this.openers.set(page, opener);
      this.page = page;
      this.invalidate();
    } catch { await page.close().catch(() => {}); }
  }
  private pendingResult(): BrowserResult {
    if (!this.dialogs.size) return { ok: true, text: JSON.stringify({ untrusted: true, dialogs: [] }) };
    const dialogs = [...this.dialogs].map(([id, { page, dialog }]) => ({ id, tab: this.tabId(page), origin: /^https?:/.test(page.url()) ? new URL(page.url()).origin : 'about:blank', type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() }));
    const page = this.page;
    const url = page?.url() ?? null;
    const response = page ? this.documentStatus.get(page) : undefined;
    const httpStatus = response && url && response.url.split('#')[0] === url.split('#')[0] ? response.status : null;
    let viewport: BrowserViewport | null = null;
    try { if (page && typeof page.viewportSize === 'function') viewport = page.viewportSize(); } catch { /* unavailable */ }
    const state: BrowserPageState = { untrusted: true, url, title: null, readyState: null, httpStatus, viewport, scroll: null, dialogs, pageError: httpStatus !== null && httpStatus >= 400 ? { type: 'http', status: httpStatus } : null };
    return { ok: true, code: 'dialog-pending', detail: { state, actionComplete: false }, text: JSON.stringify({ untrusted: true, actionComplete: false, dialogs, state }) };
  }

  private async pageState(page: Page, signal?: AbortSignal): Promise<BrowserPageState> {
    signal?.throwIfAborted();
    let title: string | null = null;
    let readyState: string | null = null;
    let viewport: BrowserViewport | null = null;
    let scroll: { x: number; y: number } | null = null;
    try {
      if (!this.dialogs.size && typeof page.evaluate === 'function') {
        const metrics = await page.evaluate(() => ({ title: document.title, readyState: document.readyState, viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY } }));
        title = typeof metrics.title === 'string' ? metrics.title : null;
        readyState = metrics.readyState ?? null;
        viewport = metrics.viewport ?? null;
        scroll = metrics.scroll ?? null;
      }
    } catch { /* unavailable during navigation */ }
    signal?.throwIfAborted();
    if (title === null && !this.dialogs.size && typeof page.title === 'function') {
      try { title = await page.title(); } catch { /* unavailable during navigation */ }
    }
    signal?.throwIfAborted();
    if (!viewport) {
      try { if (typeof page.viewportSize === 'function') viewport = page.viewportSize(); } catch { /* unavailable */ }
    }
    const url = typeof page.url === 'function' ? page.url() : null;
    const response = this.documentStatus.get(page);
    const httpStatus = response && url && response.url.split('#')[0] === url.split('#')[0] ? response.status : null;
    const dialogs = [...this.dialogs].map(([id, pending]) => ({ id, tab: this.tabId(pending.page), type: pending.dialog.type(), message: pending.dialog.message(), defaultValue: pending.dialog.defaultValue() }));
    return { untrusted: true, url, title, readyState, httpStatus, viewport, scroll, dialogs, pageError: httpStatus !== null && httpStatus >= 400 ? { type: 'http', status: httpStatus } : null };
  }

  private async observedRead(signal?: AbortSignal): Promise<BrowserResult> {
    const text = await this.untilDialog(this.read(signal), signal);
    signal?.throwIfAborted();
    const state = await this.untilDialog(this.pageState(this.page!, signal), signal);
    signal?.throwIfAborted();
    let enriched = text;
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) enriched = JSON.stringify({ ...value, state });
    } catch { /* Preserve legacy text if a custom read is not JSON. */ }
    signal?.throwIfAborted();
    return { ok: true, detail: { state }, text: enriched };
  }
  // Return control while Playwright is blocked on a dialog; observe the action
  // until explicit resolution instead of silently dismissing the dialog.
  private async untilDialog<T>(action: Promise<T>, signal?: AbortSignal): Promise<T> {
    this.suspendedActions.add(action);
    void action.then(() => this.suspendedActions.delete(action), () => this.suspendedActions.delete(action));
    const { promise, reject } = Promise.withResolvers<never>();
    const notify = () => reject(new Error('dialog pending'));
    this.dialogWaiters.add(notify);
    const cancel = () => reject(new Error('operation cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (this.dialogs.size) notify();
      if (signal?.aborted) cancel();
      return await Promise.race([action, promise]);
    } finally {
      this.dialogWaiters.delete(notify);
      signal?.removeEventListener('abort', cancel);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.invalidate();
    return this.closing ??= (async () => {
      await this.starting?.catch(() => {});
      await Promise.all([...this.dialogs.values()].map(({ dialog }) => dialog.dismiss().catch(() => {})));
      this.dialogs.clear();
      if (this.context && this.stateStore && this.saveOnExit) {
        try { await this.stateStore.save(await this.context.storageState()); this.stateStatus = 'Browser login state saved locally; may expire. Chat history is not saved.'; }
        catch { this.stateStatus = 'Browser login state save failed; no success claimed.'; }
      }
      await this.browser?.close().catch(() => {});
    })();
  }
  status(): string { return this.stateStatus; }

  async saveState(): Promise<BrowserResult> {
    if (this.dialogs.size) return this.pendingResult();
    if (!this.stateStore || !this.context || this.closed || this.busy || this.suspendedActions.size) return { ok: false, text: 'No available browser state to save.' };
    try {
      await this.stateStore.save(await this.context.storageState());
      this.saveOnExit = true;
      this.stateStatus = 'Browser login state saved locally; no credentials returned. Expiry still depends on the website. Chat is not saved.';
      return { ok: true, text: this.stateStatus };
    } catch { return { ok: false, text: 'Browser login state save failed; no success claimed.' }; }
  }

  async clearState(): Promise<BrowserResult> {
    this.saveOnExit = false;
    try {
      await this.stateStore?.clear();
      this.stateStatus = 'Saved browser state cleared; automatic exit save disabled for this process. Current in-memory login may remain; restart for a clean context.';
      return { ok: true, text: this.stateStatus };
    } catch { return { ok: false, text: 'Could not clear saved browser state.' }; }
  }

  async resumeAccess(): Promise<BrowserResult> {
    if (this.dialogs.size) return this.pendingResult();
    if (this.busy || this.closed || !this.page || this.suspendedActions.size) return { ok: false, text: 'Browser unavailable.' };
    try {
      for (const frame of this.page.frames()) await frame.locator('input,textarea').evaluateAll(nodes => {
        for (const node of nodes) { if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) node.value = ''; }
      });
      this.invalidate();
      return { ok: true, text: 'Credential fields cleared. Visible page content and screenshots can reach the model.' };
    } catch { return { ok: false, text: 'Could not clear credential fields.' }; }
  }

  private invalidate(keep?: ElementHandle) {
    for (const element of this.elements.values()) if (element !== keep) void element.dispose().catch(() => {});
    this.elements.clear();
    this.generation++;
  }
  private args(name: string, raw: string): BrowserArgs {
    if (!browserToolNames.includes(name)) throw new Error('arguments');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('arguments');
    const args = parsed as Record<string, unknown>;
    const spec = specs[name as keyof typeof specs];
    if (Object.keys(args).some(k => !(k in spec[1])) || spec[2].some(k => !(k in args))) throw new Error('arguments');
    if ('url' in args && typeof args.url !== 'string') throw new Error('arguments');
    if ('id' in args && (typeof args.id !== 'string' || !/^e\d+-\d+$/.test(args.id))) throw new Error('arguments');
    if ('text' in args && typeof args.text !== 'string') throw new Error('arguments');
    if ('tab' in args && typeof args.tab !== 'string') throw new Error('arguments');
    if ('dialog' in args && (typeof args.dialog !== 'string' || !/^d\d+$/.test(args.dialog))) throw new Error('arguments');
    if ('observe' in args && args.observe !== 'read') throw new Error('arguments');
    for (const key of ['pixels', 'milliseconds', 'timeout_ms'] as const) {
      if (key in args && (typeof args[key] !== 'number' || !Number.isSafeInteger(args[key]) || ((key === 'milliseconds' || key === 'timeout_ms') && args[key] < 0))) throw new Error('arguments');
    }
    if ('timeout_ms' in args && args.timeout_ms! > 2_147_483_647) throw new Error('arguments');
    if ('url_match' in args && !['includes', 'exact'].includes(args.url_match!)) throw new Error('arguments');
    if ('text_match' in args && !['includes', 'exact'].includes(args.text_match!)) throw new Error('arguments');
    if ('condition' in args && !['all', 'any'].includes(args.condition!)) throw new Error('arguments');
    if (name === 'browser_wait_for' && (!('url' in args || 'text' in args) || ('url' in args && args.url === '') || ('text' in args && args.text === ''))) throw new Error('arguments');
    if (('width' in args) !== ('height' in args)) throw new Error('arguments');
    for (const key of ['width', 'height'] as const) {
      if (key in args && (typeof args[key] !== 'number' || !Number.isSafeInteger(args[key]) || args[key] < 1)) throw new Error('arguments');
    }
    return args as BrowserArgs;
  }
  async loginLocal(raw: string, prompt: LocalLoginPrompt | undefined, signal: AbortSignal): Promise<BrowserResult> {
    if (this.dialogs.size) return this.pendingResult();
    if (this.closed || this.busy || this.suspendedActions.size) return { ok: false, text: 'Local login unavailable; inspect browser manually.' };
    try {
      const args: unknown = JSON.parse(raw);
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw new Error();
    } catch { return { ok: false, text: 'Local login accepts only an empty object; no target or credentials.' }; }
    if (!prompt || this.options.headless || !this.page) return { ok: false, text: 'Requires interactive TTY CLI, visible existing browser and open tgb.cn login panel.' };
    this.busy = true;
    try {
      return await localTgbLogin(this.page, prompt, signal, () => { this.invalidate(); });
    } finally { this.busy = false; }
  }

  async execute(name: string, raw: string, signal?: AbortSignal): Promise<BrowserResult> {
    if (this.closed) return { ok: false, text: 'Browser session is closed' };
    if (signal?.aborted) return { ok: false, code: 'cancelled', detail: { actionIssued: false, actionComplete: false }, text: 'Browser operation cancelled before dispatch; no action performed.' };
    const wasBusy = this.busy;
    if (wasBusy && (!this.dialogs.size || !['browser_dialogs', 'browser_dialog_accept', 'browser_dialog_dismiss', 'browser_observe'].includes(name))) return { ok: false, text: 'Browser operation in progress' };
    this.busy = true;
    let activeElement: ElementHandle | undefined;
    let actionIssued = false;
    let actionComplete = false;
    let navigation: { previous: string; current: string; noChange: boolean } | null = null;
    try {
      const args = this.args(name, raw);
      if (name === 'browser_open') await validatePublicUrl(args.url);
      signal?.throwIfAborted();
      try { await this.start(); }
      catch {
        return { ok: false, code: 'startup-failed', text: 'Managed browser could not start. Ensure Playwright dependencies are installed (npm ci), install its Chromium with npx playwright install chromium, and check OS browser dependencies/display availability (or use headless configuration). Retry browser_open after fixing the environment. No user desktop fallback was attempted.' };
      }
      const page = this.page!;
      signal?.throwIfAborted();
      if (name === 'browser_dialogs') return this.pendingResult();
      if (name === 'browser_dialog_accept' || name === 'browser_dialog_dismiss') {
        const pending = this.dialogs.get(args.dialog!);
        if (!pending) return { ok: false, code: 'stale-dialog', text: 'Dialog no longer pending. Use browser_dialogs to inspect current dialogs.' };
        if (args.text !== undefined && pending.dialog.type() !== 'prompt') throw new Error('arguments');
        if (name === 'browser_dialog_accept') await pending.dialog.accept(args.text);
        else await pending.dialog.dismiss();
        this.dialogs.delete(args.dialog!);
        this.invalidate();
        if (this.dialogs.size) return this.pendingResult();
        // Resolution does not imply the original navigation/action has finished.
        // Keep observing it without holding the command lock indefinitely.
        await Promise.resolve();
        if (this.dialogs.size) return this.pendingResult();
        if (this.suspendedActions.size) return { ok: true, code: 'action-pending', text: 'Dialog resolved; the original action is still running. Inspect browser_dialogs/browser_tabs and retry browser_wait for completion; do not repeat the action.' };
        return { ok: true, text: 'Dialog resolved explicitly. Inspect the resulting page with browser_read; action outcome is not inferred from acceptance.' };
      }
      if (this.dialogs.size && name !== 'browser_tabs' && name !== 'browser_switch') return this.pendingResult();
      if (this.suspendedActions.size && name !== 'browser_tabs') return { ok: true, code: 'action-pending', text: 'A previous action is still running. Do not repeat it. Use browser_dialogs/browser_tabs to inspect state, or retry browser_wait later.' };
      if (name === 'browser_tabs') return { ok: true, text: JSON.stringify({ active: this.tabId(page), tabs: [...this.tabs].map(([id, tab]) => ({ id, opener: this.openers.get(tab) ? this.tabId(this.openers.get(tab)!) : null, origin: /^https?:/.test(tab.url()) ? new URL(tab.url()).origin : 'about:blank' })) }) };
      if (name === 'browser_switch') {
        const target = this.tabs.get(args.tab!);
        if (!target || target.isClosed()) throw new Error('stale');
        if (target.url() !== 'about:blank') await validatePublicUrl(target.url());
        signal?.throwIfAborted();
        this.page = target;
        this.invalidate();
        return { ok: true, text: 'Tab switched. All previous refs expired; browser_read required.' };
      }
      if (['browser_read', 'browser_observe', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_scroll'].includes(name) && !/^https?:\/\//i.test(page.url())) throw new Error('unsafe current page');
      if (name === 'browser_read' || name === 'browser_observe') return await this.observedRead(signal);
      if (name === 'browser_viewport') {
        if (args.width !== undefined && args.height !== undefined) {
          actionIssued = true;
          this.invalidate();
          await this.untilDialog(page.setViewportSize({ width: args.width, height: args.height }), signal);
          actionComplete = true;
        }
        const state = await this.untilDialog(this.pageState(page, signal), signal);
        return { ok: true, detail: { state, refsExpired: actionIssued }, text: JSON.stringify({ untrusted: true, state }) };
      }
      if (name === 'browser_screenshot') {
        const image = await this.untilDialog(page.screenshot({ type: 'jpeg', quality: 55, timeout: 0, fullPage: false }), signal);
        const state = await this.untilDialog(this.pageState(page, signal), signal);
        return { ok: true, detail: { state }, text: 'Untrusted viewport screenshot.', image: image.toString('base64') };
      }
      const locator = args.id ? this.elements.get(args.id) : undefined;
      activeElement = locator;
      if (args.id && !locator) throw new Error('stale');
      this.invalidate(locator);
      signal?.throwIfAborted();
      if (name === 'browser_open') {
        const before = page.url();
        actionIssued = true;
        const response = await this.untilDialog(page.goto(args.url, { waitUntil: 'domcontentloaded' }).then(response => {
          actionComplete = true;
          return response;
        }), signal);
        if (response && typeof response.status === 'function') this.documentStatus.set(page, { url: page.url(), status: response.status() });
        navigation = { previous: before, current: page.url(), noChange: !response && page.url() === before };
      }
      if (name === 'browser_back') {
        const session = await this.context!.newCDPSession(page);
        let usable = false;
        try {
          const history = await session.send('Page.getNavigationHistory');
          const previous = history.entries[history.currentIndex - 1];
          usable = !!previous && /^https?:\/\//i.test(previous.url);
          if (usable) await validatePublicUrl(previous!.url);
        } finally { await session.detach(); }
        if (!usable) return { ok: false, code: 'no-history', detail: { state: await this.untilDialog(this.pageState(page, signal), signal), actionIssued: false, actionComplete: false }, text: 'No usable HTTP(S) back history (absent or about:blank). Still in current tab; use browser_tabs/browser_switch to return to opener.' };
        const before = page.url();
        signal?.throwIfAborted();
        actionIssued = true;
        const response = await this.untilDialog(page.goBack({ waitUntil: 'domcontentloaded' }), signal);
        if (response && typeof response.status === 'function') this.documentStatus.set(page, { url: page.url(), status: response.status() });
        navigation = { previous: before, current: page.url(), noChange: !response && page.url() === before };
        if (!response && page.url() === before) return { ok: false, code: 'history-unconfirmed', detail: { state: await this.untilDialog(this.pageState(page, signal), signal), navigation, actionIssued: true, actionComplete: false }, text: 'Back produced no observable navigation; no success claimed. Do not repeat blindly.' };
        actionComplete = true;
      }
      if (name === 'browser_click') {
        actionIssued = true;
        await this.untilDialog(locator!.click({ timeout: 0 }).then(() => {
          actionComplete = true;
        }), signal);
        signal?.throwIfAborted();
        await this.untilDialog(Promise.all([...this.popupTasks]), signal);
      }
      if (name === 'browser_fill') {
        actionIssued = true;
        await this.untilDialog(locator!.fill(args.text, { timeout: 0 }).then(() => {
          actionComplete = true;
        }), signal);
        signal?.throwIfAborted();
        if (this.dialogs.size) return this.pendingResult();
        const actual = await this.untilDialog(locator!.inputValue(), signal);
        signal?.throwIfAborted();
        const exact = actual === args.text;
        return { ok: exact, code: exact ? 'filled' : 'value-mismatch', detail: { requestedLength: args.text!.length, actualLength: actual.length, units: 'UTF-16', exact }, text: exact ? 'Fill verified exactly; no submission performed.' : 'Filled value differs from requested text; no success claimed. No values returned.' };
      }
      if (name === 'browser_scroll') {
        actionIssued = true;
        await this.untilDialog(page.mouse.wheel(0, args.pixels).then(() => {
          actionComplete = true;
        }), signal);
      }
      if (name === 'browser_wait') await this.untilDialog(page.waitForTimeout(args.milliseconds), signal);
      if (name === 'browser_wait_for') {
        const conditions = [
          ...(args.url !== undefined ? [{ type: 'url' as const, value: args.url, match: args.url_match ?? 'includes' }] : []),
          ...(args.text !== undefined ? [{ type: 'text' as const, value: args.text, match: args.text_match ?? 'includes' }] : []),
        ];
        const predicate = (payload: { conditions: { type: 'url' | 'text'; value: string; match: 'includes' | 'exact' }[]; relation: 'all' | 'any' }) => {
          const matches = payload.conditions.map(condition => {
            const actual = condition.type === 'url' ? location.href : (document.body?.innerText ?? '');
            return condition.match === 'exact' ? actual === condition.value : actual.includes(condition.value);
          });
          return payload.relation === 'all' ? matches.every(Boolean) : matches.some(Boolean);
        };
        let observed = false;
        const startedAt = Date.now();
        try {
          while (!observed) {
            signal?.throwIfAborted();
            if (this.dialogs.size) return this.pendingResult();
            if (this.closed || page.isClosed()) throw new Error('page closed');
            const remaining = args.timeout_ms === undefined || args.timeout_ms === 0 ? 100 : Math.min(100, args.timeout_ms - (Date.now() - startedAt));
            if (remaining <= 0) break;
            try {
              const wait = page.waitForFunction(predicate, { conditions, relation: args.condition ?? 'all' }, { timeout: remaining });
              const { promise, reject } = Promise.withResolvers<never>();
              const cancel = () => reject(new Error(signal?.aborted ? 'operation cancelled' : 'dialog pending'));
              this.dialogWaiters.add(cancel);
              signal?.addEventListener('abort', cancel, { once: true });
              let handle: JSHandle<unknown>;
              try { handle = await Promise.race([wait, promise]); }
              catch (error) {
                if (signal?.aborted || this.dialogs.size || this.closed || page.isClosed()) {
                  const lateHandle = await wait.then(value => value, () => undefined);
                  await lateHandle?.dispose();
                }
                throw error;
              }
              finally {
                this.dialogWaiters.delete(cancel);
                signal?.removeEventListener('abort', cancel);
              }
              try { observed = true; }
              finally { await handle.dispose(); }
            } catch (error) {
              signal?.throwIfAborted();
              if (this.dialogs.size) return this.pendingResult();
              if (this.closed || page.isClosed()) throw error;
              if (!(error instanceof Error) || !/timeout/i.test(error.message)) throw error;
              if (args.timeout_ms !== undefined && args.timeout_ms !== 0 && Date.now() - startedAt >= args.timeout_ms) break;
            }
          }
        } catch (error) {
          if (signal?.aborted || this.dialogs.size || this.closed || page.isClosed()) throw error;
          throw error;
        }
        if (this.dialogs.size) return this.pendingResult();
        signal?.throwIfAborted();
        if (args.observe === 'read' && !page.isClosed()) {
          let read: BrowserResult;
          try { read = await this.observedRead(signal); }
          catch (error) {
            signal?.throwIfAborted();
            if (this.dialogs.size || (error instanceof Error && error.message === 'dialog pending')) return this.pendingResult();
            const code = classifyBrowserError(error);
            let state: BrowserPageState | null = null;
            const current = this.page;
            if (current && !current.isClosed()) {
              try { state = await this.untilDialog(this.pageState(current, signal), signal); }
              catch { /* Preserve the original read failure if diagnostics are unavailable. */ }
            }
            signal?.throwIfAborted();
            if (this.dialogs.size) return this.pendingResult();
            return { ok: false, code, detail: { conditionObserved: observed, conditions: conditions.map(({ type, match }) => ({ type, match })), state, observation: 'read', refsExpired: false }, text: `Condition ${observed ? 'was observed' : 'was not observed'}, but optional page read failed (${code}); inspect browser state.` };
          }
          signal?.throwIfAborted();
          if (this.dialogs.size) return this.pendingResult();
          let state = read.detail?.state as BrowserPageState | undefined;
          const current = this.page;
          if (!state && current && !current.isClosed()) {
            try { state = await this.untilDialog(this.pageState(current, signal), signal); }
            catch { /* A custom read may omit diagnostics; do not invent an observation. */ }
          }
          signal?.throwIfAborted();
          if (this.dialogs.size) return this.pendingResult();
          return { ...read, ok: observed && read.ok, ...(observed ? {} : { code: 'condition-timeout' }), detail: { ...read.detail, conditionObserved: observed, conditions: conditions.map(({ type, match }) => ({ type, match })), state: state ?? null, refsExpired: false, observation: 'read' }, text: observed ? `Condition observed. ${read.text}` : `Condition was not observed before timeout. ${read.text}` };
        }
        const state = page.isClosed() ? null : await this.untilDialog(this.pageState(page, signal), signal);
        return { ok: observed, ...(observed ? {} : { code: 'condition-timeout' }), detail: { conditionObserved: observed, conditions: conditions.map(({ type, match }) => ({ type, match })), state, tab: page.isClosed() ? null : this.tabId(page), refsExpired: false }, text: observed ? 'Condition observed; no business completion is inferred.' : 'Condition was not observed before timeout; no action was performed.' };
      }
      if (this.dialogs.size) return this.pendingResult();
      const current = this.page;
      signal?.throwIfAborted();
      if (args.observe === 'read') {
        const observed = await this.observedRead(signal);
        signal?.throwIfAborted();
        const state = observed.detail?.state as BrowserPageState | undefined;
        const code = state?.pageError ? 'http-error' : navigation?.noChange ? 'navigation-unconfirmed' : undefined;
        return { ...observed, ok: !code, ...(code ? { code } : {}), detail: { ...observed.detail, navigation, actionIssued, actionComplete, observation: 'read', refsExpired: false } };
      }
      const origin = current && /^https?:/.test(current.url()) ? new URL(current.url()).origin : 'about:blank';
      const state = current ? await this.untilDialog(this.pageState(current, signal), signal) : null;
      const code = state?.pageError ? 'http-error' : navigation?.noChange ? 'navigation-unconfirmed' : undefined;
      return { ok: !code, ...(code ? { code } : {}), detail: { tab: current ? this.tabId(current) : null, origin, tabCount: this.tabs.size, refsExpired: true, state, navigation, actionIssued, actionComplete }, text: code ? 'Navigation or page state indicates an error or no observable change. Inspect state; do not blindly repeat the action.' : `Action completed. Fresh IDs require browser_read. ${this.stateStatus}` };
    } catch (error) {
      if (!signal?.aborted && error instanceof Error && error.message === 'dialog pending') return this.pendingResult();
      if (signal?.aborted || actionIssued) {
        this.invalidate();
        let state: BrowserPageState | null = null;
        if (!signal?.aborted && !this.dialogs.size && this.page) {
          try { state = await this.untilDialog(this.pageState(this.page, signal), signal); } catch { /* diagnostics are best effort */ }
        }
        return {
          ok: false,
          code: signal?.aborted ? 'cancelled' : actionComplete ? 'observation-failed' : 'action-unconfirmed',
          detail: { actionIssued, actionComplete, observationComplete: false, state, navigation },
          text: actionComplete
            ? 'Action completed, but follow-up observation failed or was cancelled. Do not repeat the action; use browser_read to inspect the current page.'
            : actionIssued
              ? 'Action may already have executed; completion is unconfirmed. No follow-up observation was performed. Do not repeat the action; inspect browser state after it settles.'
              : 'Browser operation cancelled before dispatch; no action performed.',
        };
      }
      if (error instanceof Error && error.message === 'dialog pending') return this.pendingResult();
      const detail = activeElement ? await actionabilityEvidence(activeElement) : undefined;
      const code = classifyBrowserError(error);
      this.invalidate();
      return { ok: false, code, detail, text: `Browser action failed: ${code}. Read again for fresh IDs. Diagnostics contain no field values or raw exception text.` };
    } finally {
      await activeElement?.dispose().catch(() => {});
      this.busy = wasBusy;
    }
  }
  private async read(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    this.invalidate();
    const page = this.page!;
    const generation = this.generation;
    const candidates = await page.evaluateHandle(() => {
      const native = 'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[onclick],[tabindex],label';
      const nodes = Array.from(document.querySelectorAll(`${native},div,span,li,td,img,svg`));
      const ranked: { node: Element; priority: number; index: number }[] = [];
      for (const [index, node] of nodes.entries()) {
        if (!(node instanceof HTMLElement || node instanceof SVGElement) || !node.checkVisibility()) continue;
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const style = getComputedStyle(node);
        if (!node.matches(native) && style.cursor !== 'pointer') continue;
        let overlay = false;
        for (let parent: Element | null = node; parent && parent !== document.body; parent = parent.parentElement) {
          const css = getComputedStyle(parent); const box = parent.getBoundingClientRect();
          if (parent.matches('dialog[open],[role=dialog],[aria-modal=true]') ||
              (['fixed', 'absolute'].includes(css.position) && Number(css.zIndex) > 0 && box.height > 100 && box.width > 180 && box.width < innerWidth * 0.95 && box.height < innerHeight * 0.95)) { overlay = true; break; }
        }
        const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
        ranked.push({ node, priority: overlay ? 0 : inViewport ? 1 : 2, index });
      }
      ranked.sort((a, b) => a.priority - b.priority || a.index - b.index);
      return ranked.map(entry => entry.node);
    });
    const properties = await candidates.getProperties();
    const total = properties.size;
    const elements: { id: string; role: string; label: string }[] = [];
    const collected = new Map<string, ElementHandle>();
    let committed = false;
    try {
      for (const [index, handle] of properties) {
        const locator = handle.asElement();
        if (!locator) { await handle.dispose(); continue; }
        if (!await locator.isVisible()) { await locator.dispose(); continue; }
        const info = await locator.evaluate(el => {
          const node = el as HTMLInputElement;
          return {
            role: el.getAttribute('role') || el.tagName.toLowerCase(),
            label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
            ...('value' in el ? { value: node.value } : {}),
            constraints: { maxLength: node.maxLength >= 0 ? node.maxLength : null, lengthUnits: 'UTF-16', required: node.required, readOnly: node.readOnly, disabled: node.disabled },
          };
        });
        const id = `e${generation}-${index}`;
        collected.set(id, locator);
        elements.push({ id, ...info });
      }
    const text = await page.locator('body').evaluate(body => {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const chunks: string[] = [];
      while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;
        if (!parent || parent.closest('script,style,noscript,input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"]')) continue;
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility !== 'visible' || !parent.getClientRects().length) continue;
        const text = (walker.currentNode.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) chunks.push(text);
      }
      return chunks.join(' ');
    });
    const title = await page.title();
    signal?.throwIfAborted();
    if (generation !== this.generation || page !== this.page || this.closed) throw new Error('stale page changed');
    const url = new URL(page.url());
    this.elements = collected;
    committed = true;
    return JSON.stringify({ untrusted: true, tab: this.tabId(page), opener: this.openers.get(page) ? this.tabId(this.openers.get(page)!) : null, url: url.origin, title, text, elements, elementsTotal: total, elementsTruncated: total > elements.length });
    } finally {
      await candidates.dispose().catch(() => {});
      if (!committed) await Promise.all([...properties.values()].map(handle => handle.dispose().catch(() => {})));
    }
  }
}
