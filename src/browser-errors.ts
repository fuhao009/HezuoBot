import type { ElementHandle } from 'playwright';
// Error categories informed by HezuoBot desktop/server/browser/cdp/errors.ts
// and T3 Code (MIT), Copyright 2026 T3 Tools Inc.; see NOTICE.
export function classifyBrowserError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/intercepts pointer events/i.test(message)) return 'covered';
  if (/not visible/i.test(message)) return 'not-visible';
  if (/not enabled|disabled/i.test(message)) return 'disabled';
  if (/not editable|read.?only/i.test(message)) return 'not-editable';
  if (/not stable/i.test(message)) return 'unstable';
  if (/detached|stale|context was destroyed/i.test(message)) return 'stale-ref';
  if (/Timeout|timed out/i.test(message)) return 'timeout';
  if (/closed/i.test(message)) return 'closed';
  if (/net::|navigation/i.test(message)) return 'navigation';
  if (/arguments/i.test(message)) return 'invalid-arguments';
  if (/sensitive|unsafe|public|blocked|forbidden/i.test(message)) return 'refused';
  return 'execution';
}

export async function actionabilityEvidence(element: ElementHandle): Promise<Record<string, unknown>> {
  return element.evaluate(el => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const x = Math.max(0, Math.min(innerWidth - 1, box.x + box.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, box.y + box.height / 2));
    const top = document.elementFromPoint(x, y);
    return { attached: el.isConnected, visible: box.width > 0 && box.height > 0 && style.visibility === 'visible' && style.display !== 'none', disabled: el.matches(':disabled,[aria-disabled=true]'), readOnly: el.matches('[readonly]'), centerInViewport: box.x + box.width / 2 >= 0 && box.x + box.width / 2 < innerWidth && box.y + box.height / 2 >= 0 && box.y + box.height / 2 < innerHeight, centerCovered: !!top && top !== el && !el.contains(top), coveringTag: top && top !== el && !el.contains(top) ? top.tagName.toLowerCase() : null };
  }).catch(() => ({ attached: false }));
}
