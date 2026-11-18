import type { ReadStream, WriteStream } from 'node:tty';
import { StringDecoder } from 'node:string_decoder';

export interface LocalLoginPrompt {
  collect(signal: AbortSignal): Promise<{ account: string; password: string } | null>;
  confirm(signal: AbortSignal): Promise<boolean>;
}

type Input = Pick<ReadStream, 'isTTY' | 'isRaw' | 'isPaused'> & {
  setRawMode(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end' | 'close' | 'error', listener: () => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'end' | 'close' | 'error', listener: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
};
type Output = Pick<WriteStream, 'isTTY' | 'write'>;
type Session = {
  ask(prompt: string): Promise<string | null>;
  cancel(): void;
};

/**
 * Local-only terminal input. There is deliberately NO echo (even for question
 * and account input), so a pasted password can never be echoed as typeahead.
 * Trailing data after a line terminator is discarded, not queued for another
 * prompt. Callers must keep returned credentials out of logs/model messages.
 * This class only collects local input; credentials are never echoed.
 */
export class LocalInput implements LocalLoginPrompt {
  private closed = false;
  private active?: Session;
  private readonly stdin: Input;
  private readonly stdout: Output;
  get isClosed(): boolean { return this.closed; }

  constructor(
    stdin: Input = process.stdin,
    stdout: Output = process.stdout,
  ) {
    this.stdin = stdin;
    this.stdout = stdout;
  }

  /** Cancellation/EOF/non-TTY returns an empty string. Input is not echoed. */
  question(prompt: string): Promise<string> {
    return this.run(undefined, async session => (await session.ask(prompt)) ?? '', '');
  }

  collect(signal: AbortSignal): Promise<{ account: string; password: string } | null> {
    return this.run(signal, async session => {
      const account = await session.ask('Local login (input hidden). Account: ');
      if (account === null || account.length === 0) return null;
      const password = await session.ask('Password (hidden; never echoed): ');
      if (password === null || password.length === 0) return null;
      return { account, password };
    }, null);
  }

  confirm(_signal: AbortSignal): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): void {
    this.closed = true;
    this.active?.cancel();
    this.stdin.pause();
  }

  private async run<T>(
    signal: AbortSignal | undefined,
    work: (session: Session) => Promise<T>,
    cancelled: T,
  ): Promise<T> {
    if (this.active) throw new Error('Local input is already in use');
    if (this.closed || signal?.aborted) return cancelled;
    // Fail closed: never read a pipe or enable kernel echo for secret input.
    if (!this.stdin.isTTY || !this.stdout.isTTY || typeof this.stdin.setRawMode !== 'function') {
      return cancelled;
    }

    const wasRaw = this.stdin.isRaw === true;
    const wasPaused = this.stdin.isPaused();
    let stopped = false;
    let text = '';
    let decoder = new StringDecoder('utf8');
    let settle: ((value: string | null) => void) | undefined;
    let escape = false;
    let csi = false;
    const finish = (value: string | null) => {
      const resolve = settle;
      settle = undefined;
      text = '';
      decoder = new StringDecoder('utf8');
      escape = false;
      csi = false;
      resolve?.(value);
    };
    const cancel = () => {
      stopped = true;
      finish(null);
    };
    const end = () => {
      this.closed = true;
      cancel();
    };
    const data = (chunk: Buffer | string) => {
      // Do not echo ANY part of a chunk, including pasted extra lines.
      const decoded = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (const ch of decoded) {
        if (!settle || stopped) break;
        if (ch === '\u0003' || ch === '\u0004') { if (!signal) this.closed = true; cancel(); break; }
        if (ch === '\r' || ch === '\n') { finish(text); break; }
        // Ignore terminal escape sequences rather than treating cursor keys as text.
        if (escape) {
          if (!csi && (ch === '[' || ch === 'O')) { csi = true; continue; }
          if (!csi || /[\x40-\x7e]/.test(ch)) { escape = false; csi = false; }
          continue;
        }
        if (ch === '\u001b') { escape = true; continue; }
        if (ch === '\u007f' || ch === '\b') { text = Array.from(text).slice(0, -1).join(''); continue; }
        if (ch === '\u0015') { text = ''; continue; }
        if (ch >= ' ' && ch !== '\u007f') {
          text += ch;
        }
      }
    };
    const session: Session = {
      cancel,
      ask: prompt => {
        if (stopped) return Promise.resolve(null);
        const { promise, resolve } = Promise.withResolvers<string | null>();
        settle = resolve;
        try { this.stdout.write(prompt); } catch { cancel(); }
        return promise;
      },
    };
    this.active = session;
    try {
      this.stdin.setRawMode(true);
      this.stdin.on('data', data);
      this.stdin.on('end', end);
      this.stdin.on('close', end);
      this.stdin.on('error', end);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      this.stdin.resume();
      const result = await work(session);
      return stopped ? cancelled : result;
    } catch {
      // Never include terminal input in errors.
      cancel();
      return cancelled;
    } finally {
      cancel();
      signal?.removeEventListener('abort', cancel);
      this.stdin.removeListener('data', data);
      this.stdin.removeListener('end', end);
      this.stdin.removeListener('close', end);
      this.stdin.removeListener('error', end);
      // Pause before restoring cooked mode; no readline or process signal owner.
      this.stdin.pause();
      try { this.stdin.setRawMode(wasRaw); } catch { this.closed = true; }
      if (!wasPaused && !this.closed) this.stdin.resume();
      this.active = undefined;
    }
  }
}
