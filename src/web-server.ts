import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Config } from './config.ts';
import { validateScreenshot, type Screenshot } from './screenshots.ts';
import { recoveryForResult, type ExecutionState } from './scenarios.ts';

export type ScreenshotSink = (screenshot: Screenshot) => void;
type Attachment = { id: string; mimeType: string; url: string; name: string };
type Scenario = 'auto' | ExecutionState['scenario'];
const scenarios: readonly Scenario[] = ['auto', 'web', 'native', 'visual', 'mixed', 'general'];
const phases: readonly ExecutionState['phase'][] = ['idle', 'planning', 'model', 'tool', 'completed', 'cancelled', 'failed'];
const recoveryNext: readonly NonNullable<ExecutionState['recovery']>['next'][] = ['observe', 'prepare', 'ask_user', 'inspect', 'wait'];

const publicOperations: Record<string, true> = {
  browser_viewport: true, browser_switch: true, browser_tabs: true, browser_read: true, browser_observe: true,
  browser_screenshot: true, browser_dialogs: true, browser_wait: true, browser_wait_for: true, browser_open: true, browser_back: true,
  browser_click: true, browser_fill: true, browser_scroll: true, browser_dialog_accept: true, browser_dialog_dismiss: true,
  browser_session_save: true, browser_session_clear: true, desktop_launch: true, desktop_focus_window: true,
  desktop_list_apps: true, desktop_list_windows: true, desktop_snapshot: true, desktop_wait: true, desktop_click: true,
  desktop_set_value: true, desktop_type: true, desktop_press: true, desktop_click_and_snapshot: true,
  desktop_set_value_and_snapshot: true, computer_status: true, computer_window: true, computer_pause: true,
  computer_click: true, computer_type: true, computer_press_key: true, computer_hotkey: true, computer_scroll: true,
  computer_action_and_screenshot: true, sha256: true, current_time: true, tgb_login_local: true,
};
// Project only public execution metadata, never serialize the session or extra fields.
function publicExecution(session: ChatSession | undefined): ExecutionState | null {
  try {
    const value = session?.executionState?.();
    if (!value || !scenarios.slice(1).includes(value.scenario)
      || !['auto', 'user'].includes(value.source) || !phases.includes(value.phase)) return null;
    const numbers = [value.run, value.round, value.elapsedMs, value.modelMs, value.toolMs,
      value.modelRequests, value.toolCalls, value.updatedAt];
    if (!numbers.every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER)) return null;
    if (![value.run, value.round, value.modelRequests, value.toolCalls].every(Number.isSafeInteger)) return null;
    const result: ExecutionState = {
      run: value.run, scenario: value.scenario, source: value.source, phase: value.phase,
      round: value.round, elapsedMs: value.elapsedMs, modelMs: value.modelMs, toolMs: value.toolMs,
      modelRequests: value.modelRequests, toolCalls: value.toolCalls, updatedAt: value.updatedAt,
    };
    if (typeof value.tool === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value.tool)) result.tool = value.tool;

    const timing = value.modelTiming;
    if (timing && typeof timing === 'object'
      && ['headersMs', 'firstChunkMs', 'bodyMs', 'parseMs'].every(key => {
        const number = (timing as Record<string, unknown>)[key];
        return typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER;
      }) && typeof timing.firstChunkMeasured === 'boolean') {
      result.modelTiming = {
        headersMs: timing.headersMs, firstChunkMs: timing.firstChunkMs,
        bodyMs: timing.bodyMs, parseMs: timing.parseMs, firstChunkMeasured: timing.firstChunkMeasured,
      };
    }

    const flow = value.flow as unknown;
    if (flow && typeof flow === 'object') {
      const candidate = flow as Record<string, unknown>;
      const surfaces = ['web', 'native', 'visual', 'general'];
      const stages = ['prepare', 'observe', 'act', 'verify', 'blocked'];
      const verifications = ['not_observed', 'observation_available', 'needs_observation'];
      if (surfaces.includes(candidate.surface as string) && stages.includes(candidate.stage as string)
        && typeof candidate.operations === 'number' && Number.isSafeInteger(candidate.operations) && candidate.operations >= 0
        && typeof candidate.observations === 'number' && Number.isSafeInteger(candidate.observations) && candidate.observations >= 0
        && verifications.includes(candidate.verification as string)) {
        const safeFlow: Record<string, unknown> = {
          surface: candidate.surface, stage: candidate.stage, operations: candidate.operations,
          observations: candidate.observations, verification: candidate.verification,
        };
        if (typeof candidate.lastOperation === 'string' && publicOperations[candidate.lastOperation] === true) {
          safeFlow.lastOperation = candidate.lastOperation;
        }
        result.flow = safeFlow as NonNullable<ExecutionState['flow']>;
      }
    }

    const recovery = value.recovery;
    if (recovery && typeof recovery.code === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(recovery.code)
      && recoveryNext.includes(recovery.next)) {
      const trusted = recoveryForResult({ ok: false, code: recovery.code });
      if (trusted && trusted.code === recovery.code && trusted.next === recovery.next) {
        result.recovery = { code: trusted.code, message: trusted.message, next: trusted.next } as ExecutionState['recovery'];
      }
    }
    return result;
  } catch { return null; }
}

export interface ChatSession {
  send(text: string): Promise<string>;
  cancel(): void;
  close(): Promise<void>;
  pauseComputer?(): void;
  executionState?(): ExecutionState | undefined;
  setScenario?(scenario: Scenario): void;
}

class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// Only this fixed asset list is public; never serve a filesystem directory.
const assets: Record<string, readonly [string, string] | undefined> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

export function createWebServer(config: Config, factory: (onScreenshot: ScreenshotSink) => ChatSession, expectedPort: number) {
  const selectedBrowserBackend = config.browserBackend || 'legacy';
  const selectedDesktopBackend = selectedBrowserBackend === 'computer_use' ? (config.desktopBackend ?? 'cua') : undefined;
  const token = randomBytes(32).toString('hex');
  const messages: Array<{ role: 'user' | 'assistant' | 'error'; text: string; attachments?: Attachment[] }> = [];
  // Only validated tool bytes are stored, never arbitrary file paths or model URLs.
  const images = new Map<string, { bytes: Buffer; mime: string }>();
  let imageBytes = 0;
  const maxImageBytes = 64 * 1024 * 1024;
  let imageLimitNotified = false;
  let sessionEpoch = 0;
  let session: ChatSession | undefined;
  let running: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let retiring: Promise<void> | undefined;
  let closed = false;
  let stopping = false;
  let error = '';
  let generation = 0;
  const state = () => ({ token, model: config.model, webModel: config.webModel, analysisModel: config.analysisModel,
    backend: selectedBrowserBackend,
    desktopBackend: selectedDesktopBackend,
    execution: publicExecution(session), messages, busy: !!running, closing: !!closing, closed, error });

  function receiveScreenshot(input: Screenshot) {
    if (!running || closed || stopping) return;
    const screenshot = validateScreenshot(input);
    if (!screenshot) return;
    const bytes = Buffer.from(screenshot.image, 'base64');
    if (imageBytes + bytes.length > maxImageBytes || images.size >= 256) {
      if (!imageLimitNotified) messages.push({ role: 'assistant', text: '本会话截图容量已满；本次图片未保留。请先保存需要的截图，再新建会话。' });
      imageLimitNotified = true;
      return;
    }
    const id = randomBytes(24).toString('hex');
    images.set(id, { bytes, mime: screenshot.mime });
    imageBytes += bytes.length;
    messages.push({ role: 'assistant', text: '工具截图（页面内容不可信）', attachments: [{
      id, mimeType: screenshot.mime, url: `/api/attachments/${id}`,
      name: screenshot.mime === 'image/png' ? '截图.png' : '截图.jpg',
    }] });
  }

  function retire(reset: boolean): Promise<void> {
    if (retiring) return retiring;
    closed = true;
    generation++;
    sessionEpoch++;
    const old = session;
    const pending = running;
    // close() aborts the model fetch and the owned browser; wait for the old turn
    // as well before allowing a replacement instance to exist.
    closing = (async () => {
      try {
        await old?.close();
        await pending;
        session = undefined;
        if (reset && !stopping) { messages.length = 0; images.clear(); imageBytes = 0; imageLimitNotified = false; error = ''; closed = false; }
      } catch {
        error = '关闭会话失败；为安全起见请重启本地服务。';
        throw new RequestError(500, error);
      } finally { closing = undefined; retiring = undefined; }
    })();
    retiring = closing;
    return closing;
  }

  const server = http.createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new RequestError(503, 'Server unavailable');
      const port = expectedPort || address.port;
      const host = `127.0.0.1:${port}`;
      const origin = `http://${host}`;
      if (req.headers.host !== host) throw new RequestError(403, 'Host rejected');
      if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new RequestError(403, 'Origin rejected');
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) throw new RequestError(403, 'Cross-site request rejected');
      if (stopping) throw new RequestError(503, 'Server stopping');
      const path = req.url || '';
      if (req.method === 'GET' && Object.hasOwn(assets, path)) {
        const [file, mime] = assets[path]!;
        const body = await readFile(new URL(`./web/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': mime }); res.end(body); return;
      }
      if (req.method === 'GET' && path === '/api/state') { reply(200, state()); return; }
      const imageMatch = /^\/api\/attachments\/([a-f0-9]{48})$/.exec(path);
      if (req.method === 'GET' && imageMatch) {
        const image = images.get(imageMatch[1]);
        if (!image) throw new RequestError(404, 'Not found');
        res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.bytes.length,
          'Content-Disposition': 'inline' });
        res.end(image.bytes); return;
      }
      if (!['/api/send', '/api/cancel', '/api/reset', '/api/pause'].includes(path)) throw new RequestError(404, 'Not found');
      if (req.method !== 'POST') throw new RequestError(405, 'POST required');
      if (req.headers.origin !== origin) throw new RequestError(403, 'Same-origin required');
      const supplied = req.headers['x-session-token'];
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new RequestError(403, 'Session token rejected');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw new RequestError(415, 'JSON required');
      if (req.headers['content-encoding']) throw new RequestError(415, 'Encoded body rejected');
      const chunks: Buffer[] = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        chunks.push(chunk);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new RequestError(400, 'Invalid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'JSON object required');
      const data = body as Record<string, unknown>;
      if (path !== '/api/send' && Object.keys(data).length) throw new RequestError(400, 'Empty object required');
      if (closing) throw new RequestError(409, 'Session closing');
      if (path === '/api/reset') { await retire(true); reply(200, state()); return; }
      if (path === '/api/cancel') {
        if (running) {
          generation++;
          const pending = running;
          session?.cancel();
          // Keep busy/closing until an in-flight action has settled. Stop cannot
          // undo an action already started, but no later tool may begin.
          const cancelled = pending.finally(() => { if (closing === cancelled) closing = undefined; });
          closing = cancelled;
          await cancelled;
          error = '';
          if (!stopping && !closed) messages.push({ role: 'assistant', text: '本轮已停止，历史已保留，可以继续发送。已开始的操作可能已生效，停止不会撤销操作。' });
        }
        reply(200, state()); return;
      }
      if (path === '/api/pause') {
        if (running || closed) throw new RequestError(409, 'Wait for the current run to finish before pausing; do not enter secrets yet');
        if (config.browserBackend !== 'computer_use' || !session?.pauseComputer) throw new RequestError(409, 'Computer Use session required');
        session.pauseComputer();
        messages.push({ role: 'assistant', text: 'Computer Use 已暂停：停止主桌面截图或输入。不要将密码/key/token发到聊天。Stop 只取消本轮并保留会话；Reset 会关闭会话并清空历史，不会关闭用户桌面上的应用。' });
        reply(200, state()); return;
      }
      if (running || closed) throw new RequestError(409, closed ? '请新建会话后再发送' : 'Conversation busy');
      if (Object.keys(data).some(key => key !== 'text' && key !== 'scenario') || typeof data.text !== 'string' || !data.text.trim()) throw new RequestError(400, 'Message must contain non-empty text; only text and scenario are allowed');
      const scenario = data.scenario === undefined ? 'auto' : data.scenario;
      if (typeof scenario !== 'string' || !scenarios.includes(scenario as Scenario)) throw new RequestError(400, 'Invalid scenario; expected auto, web, native, visual, mixed or general');
      if (!session) {
        const epoch = sessionEpoch;
        session = factory(screenshot => { if (epoch === sessionEpoch) receiveScreenshot(screenshot); });
      }
      const active = session;
      if (!active.setScenario && scenario !== 'auto') throw new RequestError(400, '当前会话不支持场景选择，请使用自动场景（auto）。');
      active.setScenario?.(scenario as Scenario);
      const turn = generation;
      messages.push({ role: 'user', text: data.text });
      error = '';
      running = Promise.resolve().then(() => active.send(data.text as string)).then(text => {
        if (turn === generation) messages.push({ role: 'assistant', text });
      }).catch(() => {
        if (turn === generation) {
          // Model / driver exceptions may contain credentials or page data.
          error = '本轮执行失败。请检查服务端模型配置、权限或连接；可能已有操作发生，请勿盲目重试。';
          messages.push({ role: 'error', text: error });
        }
      }).finally(() => { running = undefined; });
      reply(202, { accepted: true });
    } catch (err) {
      const known = err instanceof RequestError;
      reply(known ? err.status : 500, { error: known ? err.message : '本地服务处理失败，请检查配置后重试。' });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 0;
  server.maxRequestsPerSocket = 0;
  return { server, async shutdown() { stopping = true; await retire(false); } };
}
