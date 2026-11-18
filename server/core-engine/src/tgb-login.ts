import type { Page } from 'playwright';
import type { LocalLoginPrompt } from './local-input.ts';

export const tgbLoginDefinition = { type: 'function', function: {
  name: 'tgb_login_local',
  description: 'Local login using hidden terminal credentials and the current page login fields. No arguments, credentials, URLs or selectors accepted. Navigate to the login panel first. CAPTCHA is manual. Never ask for credentials in chat. Does not report login success.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
} };

export function validTgbUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

export async function tgbFields(page: Page, credentials?: { account: string; password: string }): Promise<void> {
  const valid = await page.evaluate(({ credentials }) => {
    const selectors = ['#userPanelName', '#userPanelPwd', '#loginBtn'];
    const nodes = selectors.map(selector => document.querySelectorAll(selector));
    if (nodes.some(list => list.length !== 1)) return false;
    const [account, password, submit] = nodes.map(list => list[0]);
    if (!(account instanceof HTMLInputElement) || account.type !== 'text' ||
        !(password instanceof HTMLInputElement) || password.type !== 'password' ||
        !(submit instanceof HTMLElement) || !['BUTTON', 'INPUT', 'A'].includes(submit.tagName)) return false;
    if ([account, password, submit].some(node => !node.checkVisibility() || node.hasAttribute('disabled')) || account.readOnly || password.readOnly) return false;
    if (credentials) {
      // Validate the field structure and set values in one browser task.
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(account, credentials.account);
      set.call(password, credentials.password);
      account.dispatchEvent(new Event('input', { bubbles: true }));
      password.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }, { credentials });
  if (!valid) throw new Error('login structure changed');
}

export async function localTgbLogin(page: Page, prompt: LocalLoginPrompt, signal: AbortSignal, _onSensitive: () => void): Promise<{ ok: boolean; text: string }> {
  let credentials: { account: string; password: string } | null = null;
  try {
    signal.throwIfAborted();
    await tgbFields(page);
    credentials = await prompt.collect(signal);
    if (!credentials || signal.aborted) return { ok: false, text: 'Local login cancelled; no submission.' };
    await tgbFields(page, credentials);
    credentials.account = ''; credentials.password = ''; credentials = null;
    signal.throwIfAborted();
    await tgbFields(page);
    await page.locator('#loginBtn').click({ timeout: 0, noWaitAfter: true });
    return { ok: true, text: 'Local fill and submit completed, NOT proof of login. Complete CAPTCHA manually in the existing browser. Conversation and browser remain until exit.' };
  } catch {
    return { ok: false, text: 'Local login cancelled, blocked or failed. No automatic retry. Submission outcome may be unknown; inspect the visible browser manually. No credentials returned.' };
  } finally {
    if (credentials) { credentials.account = ''; credentials.password = ''; }
  }
}
