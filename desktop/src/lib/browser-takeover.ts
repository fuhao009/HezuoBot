import { useEffect, useRef } from "react";

interface BrowserTakeover { botId: string; threadId: string; nonce: number; at: number }
let pending: BrowserTakeover | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

/** Only a person's chat click may request a browser takeover; never persisted or replayed across conversations. */
export function requestBrowserTakeover(botId: string, threadId: string): void {
  pending = { botId, threadId, nonce: ++nonce, at: Date.now() };
  for (const listener of listeners) listener();
}

export function useBrowserTakeover(botId: string, threadId: string, take: (nonce: number) => void): void {
  const latest = useRef(take);
  latest.current = take;
  useEffect(() => {
    const receive = () => {
      const request = pending;
      if (!request || request.botId !== botId || request.threadId !== threadId) return;
      pending = null;
      if (Date.now() - request.at <= 10_000) latest.current(request.nonce);
    };
    receive();
    listeners.add(receive);
    return () => { listeners.delete(receive); };
  }, [botId, threadId]);
}
