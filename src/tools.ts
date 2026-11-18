import { createHash } from 'node:crypto';
import { browserDefinitions } from './browser.ts';
import { tgbLoginDefinition } from './tgb-login.ts';

export const definitions = [
  { type: 'function', function: { name: 'sha256', description: 'Compute SHA-256 of supplied UTF-8 text. No file access.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } },
  { type: 'function', function: { name: 'current_time', description: 'Return the current UTC timestamp.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  ...browserDefinitions,
  tgbLoginDefinition,
  ...['browser_session_save', 'browser_session_clear'].map(name => ({ type: 'function', function: { name,
    description: name === 'browser_session_save' ? 'Save current browser cookies/localStorage in the dedicated local store, if persistence enabled. Never returns cookies. Not chat history; login may expire.' : 'Clear saved local browser state and disable automatic exit saving for this process. User authorization required. Current in-memory login may remain; restart for clean context.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  } })),
];

export function executeTool(name: string, raw: string, _allowed: readonly string[] = []): { ok: boolean; text: string } {
  try {
    const args = JSON.parse(raw);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
    if (name === 'sha256' && Object.keys(args).length === 1 && typeof args.text === 'string') {
      return { ok: true, text: createHash('sha256').update(args.text).digest('hex') };
    }
    if (name === 'current_time' && Object.keys(args).length === 0) return { ok: true, text: new Date().toISOString() };
  } catch {}
  return { ok: false, text: 'Unknown tool or invalid arguments' };
}
