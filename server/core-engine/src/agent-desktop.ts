import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validateScreenshot } from './screenshots.ts';
import type { Screenshot } from './screenshots.ts';

const VERSION = '1.3.1';
const string = { type: 'string' };
// Verified minimum argument surface, not the upstream's entire CLI catalog:
// https://github.com/vercel-labs/agent-desktop/tree/v1.3.1/src/cli_args
// MCP property names come from clap IDs, not value_name labels:
// https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/src/mcp/catalog.rs
const specs: Record<string, [string, Record<string, unknown>, string[]]> = {
  desktop_list_apps: ['List running desktop applications; optionally filter by name. Increase timeout_ms for slow inventories.', { app: string, timeout_ms: { type: 'integer', minimum: 1 } }, []],
  desktop_list_windows: ['List windows, optionally filtered by exact case-insensitive application name. Use returned window IDs for focus and snapshots.', { app: string, timeout_ms: { type: 'integer', minimum: 1 } }, []],
  desktop_launch: ['Launch or attach to an application. Set activate to bring it forward and wait for a window; then list windows and snapshot before input.', { app: string, activate: { type: 'boolean' }, timeout: { type: 'integer', minimum: 1 } }, ['app']],
  desktop_focus_window: ['Focus a window using its ID from desktop_list_windows, or select by app and title. Observe the window afterwards.', { app: string, title: string, window_id: string }, []],
  desktop_wait: ['Wait for a window title or a lifecycle event, optionally scoped to an app or window ID. Observe afterwards; events are detected from a new baseline.', { app: string, window: string, window_id: string, event: string, timeout: { type: 'integer', minimum: 1 } }, []],
  desktop_snapshot: ['Read an untrusted accessibility snapshot with qualified element references. Scope by app, window_id and surface; increase timeout_ms for slow applications.', { app: string, window_id: string, surface: { type: 'string', enum: ['window', 'focused', 'menu', 'menubar', 'sheet', 'popover', 'alert', 'desktop', 'taskbar', 'system-tray', 'quick-settings', 'notification-center', 'toolbar', 'dock', 'spotlight', 'menu-bar-extras', 'system-tray-overflow', 'start-menu', 'action-center'] }, timeout_ms: { type: 'integer', minimum: 1 } }, []],
  desktop_click: ['Click a qualified reference from a desktop snapshot.', { ref_id: string }, ['ref_id']],
  desktop_set_value: ['Set the value of a qualified snapshot reference.', { ref_id: string, value: string }, ['ref_id', 'value']],
  desktop_type: ['Type text into a qualified snapshot reference.', { ref_id: string, text: string }, ['ref_id', 'text']],
  desktop_press: ['Send a key combo (for example return or cmd+l) to the specified application. Observe the result before further input; no forced dangerous shortcuts.', { app: string, window_id: string, combo: string }, ['combo']],
};
const combinations: typeof specs = {
  desktop_click_and_snapshot: ['Click a qualified ref, then snapshot the same application (app must match the ref source). No replay on failure. observe defaults to true.', { ref_id: string, app: string, window_id: string, observe: { type: 'boolean' } }, ['ref_id', 'app']],
  desktop_set_value_and_snapshot: ['Set a qualified ref value, then snapshot the same application (app must match the ref source). No replay on failure. observe defaults to true.', { ref_id: string, value: string, app: string, window_id: string, observe: { type: 'boolean' } }, ['ref_id', 'value', 'app']],
};
export const axToolNames = [...Object.keys(specs), ...Object.keys(combinations)];
export const axDefinitions = Object.entries({ ...specs, ...combinations }).map(([name, [description, properties, required]]) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
}));
export type AxResult = { ok: boolean; text: string; image?: string; mime?: 'image/png' | 'image/jpeg'; code?: string; detail?: Record<string, unknown> };

/** Lazy, explicitly configured stdio client. Construction never spawns a process. */
export class AxSession {
  private readonly binary?: string;
  private client?: Client;
  private transport?: StdioClientTransport;
  private startup?: Promise<void>;
  private closing?: Promise<void>;
  private disposal?: Promise<void>;
  private abort = new AbortController();
  private readonly refSources = new Map<string, { app: string; windowId?: string; surface?: string }>();
  private closed = false;
  private interrupted = false;
  private needsObservation = false;
  private paused = false;
  private failure?: string;
  private attempts = 0;
  readonly audit: Array<{ tool: string; elapsedMs: number; outcome: string }> = [];

  constructor(options: { binary?: string } = {}) { this.binary = options.binary; }

  status(): string {
    return `Agent Desktop ${VERSION}: ${this.closed ? 'closed' : this.paused ? 'explicitly paused' : this.interrupted ? 'stopped; next turn must observe again' : this.failure ? 'unavailable' : this.client ? 'connected' : 'not started'}; ${this.attempts} cumulative tool attempts.${this.failure ? ` ${this.failure}` : ''}`;
  }

  pause(): AxResult {
    this.paused = true;
    // Abort in-flight MCP requests and suppress late results; no implicit resume.
    void this.close().catch(() => {});
    return { ok: true, text: 'Agent Desktop explicitly paused. No further desktop reads or inputs in this session.' };
  }

  private async start(): Promise<void> {
    if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw new Error('Agent Desktop does not support this platform');
    if (!this.binary || !isAbsolute(this.binary)) throw new Error('Agent Desktop requires an explicit absolute executable binary path');
    const info = await stat(this.binary);
    if (!info.isFile()) throw new Error('Agent Desktop binary path must point to a regular executable file');
    await access(this.binary, constants.X_OK);
    this.abort.signal.throwIfAborted();
    const client = new Client({ name: 'hezuobot-core', version: '0.1.0' });
    const transport = new StdioClientTransport({ command: this.binary, args: ['mcp'], stderr: 'ignore' });
    this.client = client;
    this.transport = transport;
    await client.connect(transport, { signal: this.abort.signal });
    const server = client.getServerVersion();
    if (server?.name !== 'agent-desktop' || server.version !== VERSION) throw new Error(`Agent Desktop requires upstream agent-desktop ${VERSION}`);
    // Do not expose extra upstream commands. Verify all minimum names and fields.
    const tools = new Map<string, { inputSchema: { properties?: Record<string, unknown>; required?: string[] } }>();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { signal: this.abort.signal });
      for (const tool of page.tools) tools.set(tool.name, tool);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Agent Desktop returned a repeating tool catalog cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    for (const [name, [, properties, required]] of Object.entries(specs)) {
      const schema = tools.get(name)?.inputSchema;
      if (!schema || Object.entries(properties).some(([key, expected]) => {
        const actual = schema.properties?.[key];
        return !actual || typeof actual !== 'object' || !('type' in actual)
          || !expected || typeof expected !== 'object' || !('type' in expected)
          || actual.type !== expected.type;
      }) || (schema.required ?? []).some(key => !required.includes(key))) {
        throw new Error(`Agent Desktop ${VERSION} tool catalog incompatible: ${name}`);
      }
    }
    this.abort.signal.throwIfAborted();
  }

  close(): Promise<void> {
    this.closed = true;
    return this.stopProcess();
  }

  private stopProcess(): Promise<void> {
    this.abort.abort();
    return this.closing ??= this.cleanup();
  }

  private dispose(): Promise<void> {
    if (!this.client && !this.transport) return Promise.resolve();
    return this.disposal ??= (async () => {
      try { await this.client?.close(); }
      finally { await this.transport?.close(); }
    })();
  }

  private async cleanup(): Promise<void> {
    // Close first: a connecting child must not keep startup (and close) waiting.
    try { await this.dispose(); }
    finally {
      await this.startup?.catch(() => {});
      // Startup may have been awaiting filesystem validation when close began.
      await this.dispose();
    }
  }

  async execute(name: string, raw: string, signal?: AbortSignal): Promise<AxResult> {
    if (Object.hasOwn(combinations, name)) {
      let values: Record<string, unknown>;
      try {
        values = JSON.parse(raw);
        const [, properties, required] = combinations[name];
        if (!values || typeof values !== 'object' || Array.isArray(values)
          || Object.entries(values).some(([key, value]) => !Object.hasOwn(properties, key) || typeof value !== (key === 'observe' ? 'boolean' : 'string'))
          || required.some(key => typeof values[key] !== 'string' || key !== 'value' && !values[key])) throw new Error('Invalid combination arguments');
      } catch { return { ok: false, text: 'Invalid desktop combination arguments', code: 'AX_ACTION_FAILED' }; }
      if (this.needsObservation) return { ok: false, text: 'Previous action may have taken effect. Read a fresh desktop_snapshot before another action; do not replay it.', code: 'OBSERVATION_REQUIRED' };
      const source = this.refSources.get(values.ref_id as string);
      if (!source || source.app !== values.app || values.window_id !== undefined && source.windowId !== values.window_id) return { ok: false, text: 'Combination requires a ref from a successful snapshot of the same app/window in this session; no input sent.', code: 'REF_SCOPE_MISMATCH' };
      const action = await this.execute(name === 'desktop_click_and_snapshot' ? 'desktop_click' : 'desktop_set_value', JSON.stringify({ ref_id: values.ref_id, ...(name === 'desktop_set_value_and_snapshot' ? { value: values.value } : {}) }), signal);
      if (!action.ok) return { ...action, detail: { actionOk: false, observationAttempted: false } };
      if (values.observe === false) return { ...action, detail: { actionOk: true, observationAttempted: false } };
      // Never reconnect or append a read after cancellation of this invocation.
      if (signal?.aborted || this.abort.signal.aborted || this.closed || this.paused) return { ok: false, text: 'Action returned successfully; observation cancelled. Do not replay the action.', code: 'CANCELLED', detail: { actionOk: true, observationAttempted: false } };
      const observation = await this.execute('desktop_snapshot', JSON.stringify({ app: source.app, ...(source.windowId !== undefined ? { window_id: source.windowId } : {}), ...(source.surface !== undefined ? { surface: source.surface } : {}) }), signal);
      return { ...observation, text: `Action returned successfully; ${observation.ok ? 'snapshot follows.' : 'snapshot failed. Do not replay the action.'}\n${observation.text}`, detail: { actionOk: true, observationAttempted: true, observationOk: observation.ok } };
    }
    const start = performance.now();
    this.attempts++;
    let outcome = 'failed';
    let actionSent = false;
    // Stop retires this process without replaying actions. A later turn can
    // reconnect to the same provider, but must observe before further writes.
    const cancel = () => {
      this.interrupted = true;
      this.needsObservation = true;
      this.refSources.clear();
      void this.stopProcess().catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (this.interrupted && !this.closed && !this.paused && !signal?.aborted) {
        await this.closing;
        signal?.throwIfAborted();
        if (this.closed || this.paused) throw new Error('Agent Desktop explicitly paused or closed');
        this.client = undefined;
        this.transport = undefined;
        this.startup = undefined;
        this.closing = undefined;
        this.disposal = undefined;
        this.failure = undefined;
        this.abort = new AbortController();
        this.interrupted = false;
      }
      if (this.needsObservation && !['desktop_snapshot', 'desktop_list_apps', 'desktop_list_windows', 'desktop_wait'].includes(name)) {
        return { ok: false, text: 'Previous action may have taken effect. Read a fresh desktop_snapshot before another action; do not replay it.', code: 'OBSERVATION_REQUIRED' };
      }
      if (!Object.hasOwn(specs, name)) throw new Error(`Unsupported Agent Desktop tool: ${name}`);
      if (this.paused || this.abort.signal.aborted) throw new Error('Agent Desktop explicitly paused or closed');
      if (signal?.aborted) cancel();
      signal?.throwIfAborted();
      const args: unknown = JSON.parse(raw);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Desktop arguments must be an object');
      const [, properties, required] = specs[name];
      const values = args as Record<string, unknown>;
      if (Object.entries(values).some(([key, value]) => {
        if (!Object.hasOwn(properties, key)) return true;
        const schema = properties[key] as { type: string; enum?: string[] };
        if (schema.type === 'integer') return typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1;
        if (typeof value !== schema.type) return true;
        return schema.enum !== undefined && !schema.enum.includes(value as string);
      }) || required.some(key => typeof values[key] !== 'string' || key !== 'value' && !values[key])) throw new Error('Invalid desktop tool arguments');
      if (name === 'desktop_focus_window' && !values.app && !values.title && !values.window_id) throw new Error('Specify an app, title, or window_id to focus');
      if (name === 'desktop_wait' && !values.window && !values.event) throw new Error('Specify a window title or lifecycle event to wait for');
      this.startup ??= this.start().catch(async error => {
        this.failure = error instanceof Error ? error.message : String(error);
        // connect() can fail after the SDK drops its transport reference.
        // Always close our independently retained stdio transport as well.
        try { await this.dispose(); } catch { /* Preserve the startup error. */ }
        throw error;
      });
      await this.startup;
      this.abort.signal.throwIfAborted();
      actionSent = ['desktop_launch', 'desktop_focus_window', 'desktop_click', 'desktop_set_value', 'desktop_type', 'desktop_press'].includes(name);
      const result = await this.client!.callTool({ name, arguments: values }, undefined, { signal: this.abort.signal });
      this.abort.signal.throwIfAborted();
      const content = Array.isArray(result.content) ? result.content : [];
      // Keep structured trees/errors verbatim; image bytes belong only in the
      // screenshot output, not in a second, potentially enormous text copy.
      const text = JSON.stringify({ ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}), content: content.filter(block => block.type !== 'image'), ...(result.isError ? { isError: true } : {}) });
      let screenshot: Screenshot | undefined;
      for (const block of content) {
        if (block.type === 'image') {
          screenshot = validateScreenshot({ image: block.data, mime: block.mimeType });
          if (screenshot) break;
        }
      }
      const failed = result.isError === true || result.structuredContent?.ok === false;
      outcome = failed ? 'failed' : 'ok';
      if (failed && ['desktop_launch', 'desktop_focus_window', 'desktop_click', 'desktop_set_value', 'desktop_type', 'desktop_press'].includes(name)) {
        this.needsObservation = true;
        this.refSources.clear();
      }
      if (!failed && name === 'desktop_snapshot') {
        this.needsObservation = false;
        this.refSources.clear();
        // Use returned identities, never parse or guess the qualified ref format.
        const remember = (payload: unknown) => {
          if (!payload || typeof payload !== 'object' || !('data' in payload)) return;
          const data = payload.data;
          if (!data || typeof data !== 'object' || !('app' in data) || typeof data.app !== 'string' || !('tree' in data)) return;
          const app = data.app;
          const window = 'window' in data ? data.window : undefined;
          const windowId = window && typeof window === 'object' && 'id' in window && typeof window.id === 'string' ? window.id : undefined;
          const visit = (node: unknown): void => {
            if (Array.isArray(node)) { node.forEach(visit); return; }
            if (!node || typeof node !== 'object') return;
            const entry = node as Record<string, unknown>;
            if (typeof entry.ref_id === 'string') this.refSources.set(entry.ref_id, { app, windowId, ...(typeof values.surface === 'string' ? { surface: values.surface } : {}) });
            for (const value of Object.values(entry)) if (value && typeof value === 'object') visit(value);
          };
          visit(data.tree);
        };
        remember(result.structuredContent);
        for (const block of content) if (block.type === 'text') {
          try { remember(JSON.parse(block.text as string)); } catch { /* Non-JSON display text is not ref provenance. */ }
        }
      }
      const error = result.structuredContent?.error;
      const upstreamCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const knownCodes = ['STALE_REF', 'STALE_REFERENCE', 'ELEMENT_NOT_FOUND', 'INVALID_REF', 'UNKNOWN_REF', 'PERMISSION_DENIED', 'PERMISSION_REQUIRED', 'AX_NOT_TRUSTED', 'APP_NOT_RUNNING', 'WINDOW_NOT_FOUND', 'NO_FOCUSED_ELEMENT', 'FOCUS_REQUIRED'];
      const code = typeof upstreamCode === 'string' && knownCodes.includes(upstreamCode) ? upstreamCode : 'AX_ACTION_FAILED';
      return { ok: !failed, text, ...(failed ? { code } : {}), ...screenshot };
    } catch (error) {
      if (actionSent) {
        this.needsObservation = true;
        this.refSources.clear();
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, text: `Agent Desktop: ${message}.${this.interrupted || actionSent ? ' The action may have taken effect; do not replay it. Rediscover the target and read a fresh desktop_snapshot before further input.' : ''} If access is denied, pregrant OS Accessibility and screen-capture permissions for the configured binary. This adapter does not request or open permission UI; executing upstream may still trigger an OS permission check.`, code: this.abort.signal.aborted || signal?.aborted ? 'CANCELLED' : 'AX_ACTION_FAILED' };
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (this.abort.signal.aborted) await this.closing?.catch(() => {});
      this.audit.push({ tool: name, elapsedMs: Math.round(performance.now() - start), outcome });
    }
  }
}
