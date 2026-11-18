import { homedir } from 'node:os';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { object } from './openai-chat-protocol.ts';

const VERSION = '0.38.0';
const coordinates = { x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 } };
const specs = {
  computer_window: ['Capture the primary desktop at full resolution. Returned PNG dimensions are physical image pixels, not logical screen points. Coordinates start at its top-left (0,0), x right, y down. Use original PNG coordinates, not a resized UI preview. No screenshot prerequisite for input.', {}],
  computer_click: ['Click primary-desktop screenshot pixel coordinates (top-left origin, x right, y down), not logical points or resized preview coordinates. After a size change, re-locate the target on the latest image; do not reuse stale coordinates.', coordinates],
  computer_scroll: ['Scroll at primary-desktop screenshot pixel coordinates (top-left origin, x right, y down). Re-locate on the latest image after size changes.', { ...coordinates, direction: { enum: ['up', 'down'] } }],
  computer_hotkey: ['Send a combination separated by +, e.g. Meta+l for the address bar in an already focused browser. This does not focus a browser or prove navigation. Backspace is supported by computer_press_key, not the hotkey interface. Other supported keys depend on CuaDriver.', { keys: { type: 'string', minLength: 1 } }],
  computer_type: ['Type nonempty text into the currently focused control. Focus is not established or verified by this tool.', { text: { type: 'string', minLength: 1 } }],
  computer_press_key: ['Send one key, e.g. Backspace (single-key interface only) or enter. Use computer_hotkey for combinations such as Meta+l. Supported keys depend on CuaDriver.', { key: { type: 'string', minLength: 1 } }],
  computer_pause: ['Explicitly stop screenshots and inputs for this session.', {}],
  computer_status: ['Read last-known local driver connection/catalog state and recent screenshot geometry without connecting, probing, capturing, changing focus or sending input. Permissions and current focus remain unknown.', {}],
} as const;
const actionNames = ['computer_click', 'computer_scroll', 'computer_hotkey', 'computer_type', 'computer_press_key'] as const;
const combinationName = 'computer_action_and_screenshot';
export const computerToolNames = [...Object.keys(specs), combinationName];
export const computerDefinitions = Object.entries(specs).map(([name, [description, properties]]) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } },
}));
computerDefinitions.push({
  type: 'function', function: { name: combinationName, description: 'Dispatch exactly one desktop input, then optionally observe the primary desktop. ok is request/observation status, never business success. Inspect action.dispatch and observation; a screenshot does not verify the intended effect. No replay or focus changes. observe defaults to true; after a size change re-locate on the latest image.', parameters: {
    type: 'object', properties: { action: { oneOf: actionNames.map(name => ({ type: 'object', properties: { name: { const: name }, arguments: { type: 'object', properties: specs[name][1], required: Object.keys(specs[name][1]), additionalProperties: false } }, required: ['name', 'arguments'], additionalProperties: false })) }, observe: { type: 'boolean' } }, required: ['action'], additionalProperties: false,
  } },
} as typeof computerDefinitions[number]);
type Dispatch = 'dispatched' | 'not_dispatched' | 'unknown';
type ActionOutcome = {
  name: string; dispatch: Dispatch; driverEffect?: string; businessSuccess: 'unverified';
};
type Screenshot = {
  sequence: number; capturedAt: string;
  physicalPixels: { width: number; height: number; source: 'png' };
  target: { kind: 'desktop'; display_id: 'primary'; source: 'driver-primary-desktop-contract'; resolvedDisplayId: null };
  coordinates: { unit: 'screenshot_pixel'; origin: 'top-left'; xDirection: 'right'; yDirection: 'down' };
  scaleFactor: null; foregroundApp: null;
  dimensionsChanged: boolean; previousPhysicalPixels?: { width: number; height: number };
  relocationRequired: boolean; guidance: string;
};
type DesktopContext = {
  lifecycle: 'active' | 'paused' | 'closed';
  driver: { connection: 'not_started' | 'connecting' | 'connected' | 'closed'; expectedVersion: string; catalogValidated: boolean; capabilities: string[] };
  permissions: 'unknown'; focus: 'unknown';
  lastCapture: 'never' | 'pending' | 'succeeded' | 'failed' | 'cancelled'; lastScreenshot: Screenshot | null;
};
type Result = {
  // Request-level status only: it does not establish the user's intended outcome.
  ok: boolean; text: string; image?: string; mime?: 'image/png'; code?: string;
  action?: ActionOutcome; screenshot?: Screenshot; context?: DesktopContext;
  observation?: { attempted: boolean; status: 'succeeded' | 'failed' | 'skipped' | 'cancelled'; businessSuccess: 'unverified' };
  detail?: { actionOk: boolean; observationAttempted: boolean; observationOk?: boolean };
};
const capabilities = ['get_desktop_state', 'click', 'scroll', 'hotkey', 'type_text', 'press_key'];
const fail = (text: string): Result => ({ ok: false, text });

export class ComputerSession {
  private client?: Client;
  private transport?: StdioClientTransport;
  private startup?: Promise<void>;
  private closing?: Promise<void>;
  private interrupted?: Promise<void>;
  private terminated = false;
  private requests: Promise<void> = Promise.resolve();
  private abort = new AbortController();
  private paused = false;
  private actions = 0;
  private inputFailures = 0;
  private connection: DesktopContext['driver']['connection'] = 'not_started';
  private catalogValidated = false;
  private lastCapture: DesktopContext['lastCapture'] = 'never';
  private lastScreenshot: Screenshot | null = null;
  readonly audit: Array<{ tool: string; elapsedMs: number; outcome: string }> = [];

  status(): string {
    return `Computer Use: ${this.terminated ? 'closed' : this.paused ? 'explicitly paused' : 'primary desktop'}; driver ${this.connection}, catalog ${this.catalogValidated ? 'validated' : 'not validated'}; permissions/focus unknown; last capture ${this.lastCapture}; ${this.actions} cumulative tool attempts; ${this.inputFailures} cumulative input failures; shared daemon not stopped.`;
  }

  private context(): DesktopContext {
    return {
      lifecycle: this.terminated ? 'closed' : this.paused ? 'paused' : 'active',
      driver: { connection: this.connection, expectedVersion: VERSION, catalogValidated: this.catalogValidated, capabilities: this.catalogValidated ? [...capabilities] : [] },
      permissions: 'unknown', focus: 'unknown', lastCapture: this.lastCapture,
      // Return a snapshot, not mutable session state. This is historical, not a live desktop assertion.
      lastScreenshot: this.lastScreenshot ? structuredClone(this.lastScreenshot) : null,
    };
  }

  private async start() {
    this.connection = 'connecting';
    if (process.platform !== 'darwin') throw new Error('Computer Use requires macOS');
    const socket = join(homedir(), 'Library/Caches/cua-driver/cua-driver.sock');
    const info = await lstat(socket);
    if (!info.isSocket() || info.uid !== process.getuid?.()) throw new Error('Existing local CuaDriver socket required');
    // Static import cannot work on hosts without the platform-specific native binary.
    const { CuaDriver } = await import('@trycua/cua-driver');
    const metadata = await CuaDriver.connect(socket).metadata({ signal: this.abort.signal });
    if (metadata.driverVersion !== VERSION) throw new Error('CuaDriver version mismatch');
    this.abort.signal.throwIfAborted();
    this.client = new Client({ name: 'hezuobot-core', version: '0.1.0' });
    this.transport = new StdioClientTransport({
      command: '/Applications/CuaDriver.app/Contents/MacOS/cua-driver', args: ['mcp', '--socket', socket],
      env: { HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stderr: 'ignore',
    });
    // The MCP SDK retains its own default deadline; no application timeout is added.
    await this.client.connect(this.transport, { signal: this.abort.signal });
    const remote = this.client.getServerVersion();
    if (remote?.name !== 'cua-driver' || remote.version !== VERSION) throw new Error('CuaDriver stdio version mismatch');
    // MCP uses snake_case and flattened x/y, unlike native SDK ClickInput.position.
    // Verify the connected version's actual catalog before any input is sent.
    const expected: Record<string, string[]> = {
      get_desktop_state: [], click: ['target', 'delivery_mode', 'x', 'y', 'button'],
      scroll: ['target', 'delivery_mode', 'x', 'y', 'direction', 'amount', 'by'],
      hotkey: ['target', 'delivery_mode', 'keys'], type_text: ['target', 'delivery_mode', 'text'],
      press_key: ['target', 'delivery_mode', 'key'],
    };
    const tools = new Map<string, { inputSchema: { properties?: Record<string, unknown>; required?: string[] } }>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : {}, { signal: this.abort.signal });
      for (const tool of page.tools) tools.set(tool.name, tool);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('CuaDriver repeating tool catalog cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    for (const [name, keys] of Object.entries(expected)) {
      const schema = tools.get(name)?.inputSchema;
      if (!schema || keys.some(key => !Object.hasOwn(schema.properties ?? {}, key))
        || (schema.required ?? []).some(key => !keys.includes(key))) throw new Error(`CuaDriver incompatible MCP schema: ${name}`);
    }
    this.abort.signal.throwIfAborted();
    this.catalogValidated = true;
    this.connection = 'connected';
  }

  close(): Promise<void> {
    this.terminated = true;
    return this.closing ??= this.interrupted ?? this.cleanup();
  }

  private async cleanup() {
    this.abort.abort();
    this.connection = 'closed';
    // Close before awaiting startup: cancellation must also unblock connect().
    const client = this.client;
    const transport = this.transport;
    const initial = await Promise.allSettled([client?.close(), transport?.close()]);
    await this.startup?.catch(() => {});
    // Startup may install different resources while initial cleanup is pending.
    // Close those too, but do not close the same client or transport twice.
    const final = await Promise.allSettled([
      this.client !== client ? this.client?.close() : undefined,
      this.transport !== transport ? this.transport?.close() : undefined,
    ]);
    const failure = [...initial, ...final].find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private async call(name: string, args: Record<string, unknown>) {
    this.abort.signal.throwIfAborted();
    const r = await this.client!.callTool({ name, arguments: args }, undefined, { signal: this.abort.signal });
    this.abort.signal.throwIfAborted();
    if (r.isError) throw new Error('CuaDriver refused or failed the request');
    return { data: object(r.structuredContent), content: r.content };
  }

  private async timedCall(name: string, args: Record<string, unknown>) {
    const start = performance.now();
    try {
      const result = await this.call(name, args);
      const effect = result.data?.effect;
      const outcome = typeof effect === 'string' && ['refused', 'failed', 'unverifiable', 'confirmed', 'dispatched'].includes(effect) ? effect : 'returned';
      this.audit.push({ tool: name, elapsedMs: Math.round(performance.now() - start), outcome });
      return result;
    } catch (error) {
      this.audit.push({ tool: name, elapsedMs: Math.round(performance.now() - start), outcome: 'failed' });
      throw error;
    }
  }

  pause() {
    this.paused = true;
    return { ok: true, text: 'Computer Use explicitly paused. No more screenshots or inputs in this session.' };
  }

  async execute(name: string, raw: string, signal?: AbortSignal): Promise<Result> {
    // Do not let a new request observe or replace resources while an old Stop is draining.
    const pending = this.requests.then(() => this.executeWithContext(name, raw, signal));
    this.requests = pending.then(() => {}, () => {});
    return pending;
  }

  private async executeWithContext(name: string, raw: string, signal?: AbortSignal): Promise<Result> {
    const result = await this.executeRequest(name, raw, signal);
    if (result.code === 'CANCELLED') result.text += ' Cancellation does not establish the action effect or business outcome. Observe the desktop again before deciding what to do next; do not replay automatically. Stop is not a permanent session close.';
    if (actionNames.includes(name as typeof actionNames[number]) && !result.action) {
      result.action = { name, dispatch: 'not_dispatched', businessSuccess: 'unverified' };
    }
    // Core/UI already consume text plus image/mime. Keep image bytes exclusively in that channel.
    const metadata = { action: result.action, observation: result.observation, screenshot: result.screenshot, context: result.context };
    if (Object.values(metadata).some(value => value !== undefined)) result.text += `\nComputer context: ${JSON.stringify(metadata)}`;
    return result;
  }

  private async executeRequest(name: string, raw: string, signal?: AbortSignal): Promise<Result> {
    const cancel = () => {
      // Stop closes only our owned connection, not the shared daemon or this session.
      this.interrupted ??= this.cleanup().catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) { cancel(); return { ...fail('Computer request cancelled; dispatch/effect may be unknown. Observe the desktop again before deciding the next action; do not replay automatically.'), code: 'CANCELLED' }; }
      if (name !== combinationName) return await this.executeOne(name, raw);
      let values: Record<string, unknown> | undefined;
      try { values = object(JSON.parse(raw)); } catch { /* Invalid JSON rejected below. */ }
      const action = object(values?.action);
      if (!values || Object.keys(values).some(key => !['action', 'observe'].includes(key))
        || (values.observe !== undefined && typeof values.observe !== 'boolean') || !action
        || Object.keys(action).length !== 2 || !Object.hasOwn(action, 'arguments')
        || !actionNames.includes(action.name as typeof actionNames[number]) || !object(action.arguments)) return fail('Invalid computer combination arguments');
      const result = await this.executeOne(action.name as string, JSON.stringify(action.arguments));
      const outcome: ActionOutcome = result.action ?? { name: action.name as string, dispatch: 'not_dispatched', businessSuccess: 'unverified' };
      if (!result.ok) return { ...result, action: outcome, observation: { attempted: false, status: result.code === 'CANCELLED' ? 'cancelled' : 'skipped', businessSuccess: 'unverified' }, detail: { actionOk: false, observationAttempted: false } };
      if (values.observe === false) return { ...result, action: outcome, observation: { attempted: false, status: 'skipped', businessSuccess: 'unverified' }, detail: { actionOk: true, observationAttempted: false } };
      if (signal?.aborted || this.abort.signal.aborted || this.paused) return { ...fail('Action request returned; observation cancelled. Business outcome unverified. Do not replay the action.'), action: outcome, observation: { attempted: false, status: 'cancelled', businessSuccess: 'unverified' }, code: 'CANCELLED', detail: { actionOk: true, observationAttempted: false } };
      const observation = await this.executeOne('computer_window', '{}');
      return { ...observation, action: outcome, observation: { attempted: true, status: observation.ok ? 'succeeded' : observation.code === 'CANCELLED' ? 'cancelled' : 'failed', businessSuccess: 'unverified' }, text: `${result.text}\n${observation.ok ? 'Observation captured; intended business outcome remains unverified.' : 'Observation failed. Do not replay the action.'}\n${observation.text}`, detail: { actionOk: true, observationAttempted: true, observationOk: observation.ok } };
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (this.interrupted) {
        await this.interrupted;
        this.interrupted = undefined;
        if (!this.terminated && !this.paused) {
          this.client = undefined;
          this.transport = undefined;
          this.startup = undefined;
          this.abort = new AbortController();
          this.connection = 'not_started';
          this.catalogValidated = false;
          if (this.lastCapture === 'pending') this.lastCapture = 'cancelled';
        }
      }
    }
  }

  private async executeOne(name: string, raw: string): Promise<Result> {
    if (!Object.hasOwn(specs, name)) return fail('Invalid computer tool');
    let args: Record<string, unknown> | undefined;
    try { args = object(JSON.parse(raw)); } catch { return fail('Invalid computer arguments'); }
    const props = specs[name as keyof typeof specs][1];
    if (!args || Object.keys(args).length !== Object.keys(props).length || !Object.keys(props).every(k => Object.hasOwn(args!, k))) return fail('Unexpected computer arguments');
    if (name === 'computer_pause') return this.pause();
    if (name === 'computer_status') {
      return { ok: true, text: 'Read-only local Computer Use context, not a live connection probe. Connection is last known; capabilities describe the validated catalog, not granted OS permissions. Last screenshot is historical; current focus, permissions and business outcome are unknown.', context: this.context() };
    }
    if (this.paused || this.abort.signal.aborted) return fail('Computer Use explicitly paused or closed');
    this.actions++;
    if (name === 'computer_hotkey' && (typeof args.keys !== 'string' || !args.keys.split('+').every(key => key.trim().length > 0)) || name === 'computer_type' && (typeof args.text !== 'string' || !args.text.length) || name === 'computer_press_key' && (typeof args.key !== 'string' || !args.key.trim().length) || name === 'computer_scroll' && args.direction !== 'up' && args.direction !== 'down') return fail('Invalid computer argument value');
    if ((name === 'computer_click' || name === 'computer_scroll') && ![args.x, args.y].every(value => Number.isSafeInteger(value) && Number(value) >= 0)) return fail('Invalid desktop coordinates');
    if (name === 'computer_window') this.lastCapture = 'pending';
    try {
      await (this.startup ??= this.start());
    } catch {
      const cancelled = this.abort.signal.aborted;
      if (name === 'computer_window') this.lastCapture = cancelled ? 'cancelled' : 'failed';
      if (cancelled) return { ...fail('Computer request cancelled during startup; effect unknown. Observe again before deciding the next action; do not replay automatically.'), code: 'CANCELLED' };
      await this.close();
      throw new Error('Computer Use preflight failed: requires macOS, CuaDriver 0.38.0 stdio and an existing socket, and OS Accessibility/Screen Recording permissions.');
    }
    let inputAttempted = false;
    try {
      this.abort.signal.throwIfAborted();
      if (this.paused) {
        if (name === 'computer_window') this.lastCapture = 'failed';
        return fail('Computer Use explicitly paused');
      }
      if (name === 'computer_window') {
        const { content } = await this.timedCall('get_desktop_state', {});
        this.lastCapture = 'failed';
        const images = Array.isArray(content) ? content.filter(x => x.type === 'image') : [];
        const img = images[0];
        const payload = img?.data;
        if (images.length !== 1 || img?.mimeType !== 'image/png' || typeof payload !== 'string' || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return fail('Desktop capture missing or invalid');
        const png = Buffer.from(payload, 'base64');
        if (png.toString('base64') !== payload || png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(16) < 1 || png.readUInt32BE(20) < 1) return fail('Invalid desktop PNG');
        if (this.paused || this.abort.signal.aborted) {
          this.lastCapture = this.abort.signal.aborted ? 'cancelled' : 'failed';
          return { ...fail('Session explicitly paused or closed during capture; image discarded'), code: this.abort.signal.aborted ? 'CANCELLED' : 'COMPUTER_ERROR' };
        }
        const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
        const previous = this.lastScreenshot?.physicalPixels;
        const dimensionsChanged = !!previous && (previous.width !== width || previous.height !== height);
        const screenshot: Screenshot = {
          sequence: (this.lastScreenshot?.sequence ?? 0) + 1, capturedAt: new Date().toISOString(),
          physicalPixels: { width, height, source: 'png' },
          target: { kind: 'desktop', display_id: 'primary', source: 'driver-primary-desktop-contract', resolvedDisplayId: null },
          coordinates: { unit: 'screenshot_pixel', origin: 'top-left', xDirection: 'right', yDirection: 'down' },
          scaleFactor: null, foregroundApp: null, dimensionsChanged,
          ...(previous ? { previousPhysicalPixels: { width: previous.width, height: previous.height } } : {}),
          relocationRequired: dimensionsChanged,
          guidance: dimensionsChanged
            ? 'Screenshot dimensions changed. Re-locate the target on this latest PNG before choosing coordinates; do not reuse old coordinates. No input was replayed or focus changed.'
            : 'Use original PNG pixels, not logical points or resized preview coordinates. Locate the intended target visually; unchanged dimensions do not prove unchanged content or focus.',
        };
        this.lastScreenshot = structuredClone(screenshot);
        this.lastCapture = 'succeeded';
        return { ok: true, text: `Primary desktop PNG: ${width}x${height} physical image pixels; origin (0,0) top-left, x right, y down. Scale factor and foreground app unknown. ${screenshot.guidance}`, screenshot, image: payload, mime: 'image/png' };
      }
      const target = { target: { kind: 'desktop', display_id: 'primary' }, delivery_mode: 'foreground' };
      let request: [string, Record<string, unknown>];
      if (name === 'computer_click') {
        request = ['click', { x: args.x, y: args.y, button: 'left' }];
      } else if (name === 'computer_scroll') {
        request = ['scroll', { x: args.x, y: args.y, direction: args.direction, amount: 4, by: 'line' }];
      } else if (name === 'computer_hotkey') {
        request = ['hotkey', { keys: (args.keys as string).split('+').map(key => key.trim()) }];
      } else if (name === 'computer_type') {
        request = ['type_text', { text: args.text }];
      } else if (name === 'computer_press_key') {
        request = ['press_key', { key: args.key === 'enter' ? 'return' : args.key }];
      } else return fail('Unsupported computer action');
      inputAttempted = true;
      const { data } = await this.timedCall(request[0], { ...target, ...request[1] });
      const driverEffect = typeof data?.effect === 'string' && ['refused', 'failed', 'unverifiable', 'confirmed', 'dispatched'].includes(data.effect) ? data.effect : undefined;
      const action: ActionOutcome = { name, dispatch: driverEffect === 'refused' ? 'not_dispatched' : driverEffect === 'dispatched' || driverEffect === 'confirmed' ? 'dispatched' : 'unknown', ...(driverEffect ? { driverEffect } : {}), businessSuccess: 'unverified' };
      if (driverEffect === 'refused' || driverEffect === 'failed' || data?.ok === false || data?.success === false) {
        this.inputFailures++;
        return { ...fail('CuaDriver refused or failed the desktop input. Intended effect unverified; do not replay the action.'), action };
      }
      if (this.paused || this.abort.signal.aborted) return { ...fail('Session explicitly paused or closed during input; intended effect unverified. Do not replay the action.'), action, code: this.abort.signal.aborted ? 'CANCELLED' : 'COMPUTER_ERROR' };
      return { ok: true, action, text: action.dispatch === 'dispatched'
        ? 'Desktop action dispatched according to driver evidence; intended business outcome unverified. Observe and assess the desktop; do not infer success from ok.'
        : 'CuaDriver returned without a dispatch error, but dispatch is unverified. Intended business outcome unverified; do not infer success from ok or automatically replay.' };
    } catch {
      if (name !== 'computer_window') this.inputFailures++;
      else this.lastCapture = this.abort.signal.aborted ? 'cancelled' : 'failed';
      return { ...fail(name === 'computer_window' ? 'CuaDriver capture failed.' : 'CuaDriver request failed; input may have taken effect. Do not replay the action or switch backend.'), ...(name !== 'computer_window' ? { action: { name, dispatch: inputAttempted ? 'unknown' : 'not_dispatched', businessSuccess: 'unverified' } as ActionOutcome } : {}), code: this.abort.signal.aborted ? 'CANCELLED' : 'COMPUTER_ERROR' };
    }
  }
}
