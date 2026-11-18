import { setTimeout as sleep } from "node:timers/promises";

import { attachPage, clickButtonByText, fillField, listPages } from "./cdp.mjs";

export { verifyNewBotAvatars } from "./new-bot-avatar-ui.mjs";

/** Opens Settings → Your account from the product sidebar's account button. */
export async function openAccountSettings(page) {
  // The account button main marks for this purpose, never "the first button in the footer" (that is Automations).
  await page.until("Boolean(document.querySelector('[data-product-account-open]'))", { label: "the product account button" });
  if (!await page.evaluate("Boolean(document.querySelector('[role=dialog]'))")) {
    await page.evaluate("(() => { document.querySelector('[data-product-account-open]').click(); return true; })()");
  }
  await page.until("Boolean(document.querySelector('[role=dialog]'))", { label: "the settings dialog" });
  // Simple mode lists pages (Usage & billing) rather than the advanced per-section rail; either way the
  // account page must end up rendered, and opening the sidebar account button normally lands there.
  await page.until("Boolean(document.querySelector('[data-settings-section=account], [data-settings-page]'))", { label: "the settings navigation" });
  if (!await page.evaluate("Boolean(document.querySelector('[data-product-account]'))")) {
    const clicked = await page.evaluate(`(() => {
      const direct = document.querySelector('[data-settings-section=account]');
      if (direct) { direct.click(); return "section"; }
      if (document.querySelector('[data-product-account]')) return "already";
      const pageButton = [...document.querySelectorAll('[data-settings-page]')]
        .find(button => button.getAttribute("data-settings-page") === "billing");
      if (!pageButton) return "";
      pageButton.click();
      return "billing";
    })()`);
    if (clicked === "billing") {
      // Usage & billing opens on Usage; the account page is its own section in the mobile selector.
      const selected = await page.evaluate(`(() => {
        const select = document.querySelector('[role=dialog] select');
        const option = [...(select?.options ?? [])].find(item => item.value === "account");
        if (!select || !option) return false;
        select.value = "account";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
      if (!selected) {
        await page.evaluate(`(() => {
          const section = document.querySelector('[data-settings-section=account]');
          if (section) section.click();
          return true;
        })()`);
      }
    }
  }
  await page.until("Boolean(document.querySelector('[data-product-account]'))", { label: "the account page" });
}

export async function closeSettings(page) {
  await page.evaluate(`(() => {
    const dialog = document.querySelector('[role=dialog]');
    if (!dialog) return true;
    const close = [...dialog.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === "Close settings");
    if (!close) return false;
    close.click();
    return true;
  })()`);
  await page.until("!document.querySelector('[role=dialog]')", { label: "settings closed", timeoutMs: 20_000 });
}

/** Types and sends through the app's own composer (its Enter handler). */
export async function sendMessage(page, text) {
  const filled = await page.evaluate(`(() => {
    const field = document.querySelector("textarea[aria-label]");
    if (!field) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.focus();
    return true;
  })()`);
  if (!filled) throw new Error("the composer is not on screen");
  await page.evaluate(`(() => {
    const field = document.querySelector("textarea[aria-label]");
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    return true;
  })()`);
  await page.until('(document.querySelector("textarea[aria-label]")?.value ?? "").length === 0', {
    label: "the composer clears after send", timeoutMs: 30_000,
  });
}

export async function waitForText(page, text, timeoutMs = 120_000) {
  await page.until(`document.body.innerText.includes(${JSON.stringify(text)})`, { label: `the text ${JSON.stringify(text)}`, timeoutMs });
}

/** No pending approval and no Stop control: the turn is over. */
export async function waitSettled(page, timeoutMs = 120_000) {
  await page.until("!([...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Allow once'))", { label: "no pending approval", timeoutMs });
  await page.until("!document.querySelector('[data-composer-stop], button[aria-label=\"Stop this turn\"]')", {
    label: "the turn finished", timeoutMs,
  });
}

/** A mutating workspace call through the app's own page (the account session
 * adds the desktop owner header), never a direct Node request. */
export async function workspaceApi(page, method, path, body) {
  const result = await page.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)},
      headers: { "content-type": "application/json" },
      body: ${JSON.stringify(JSON.stringify(body))},
    });
    return { status: response.status, text: (await response.text()).slice(0, 600) };
  })()`);
  if (result.status < 200 || result.status >= 300) throw new Error(`${method} ${path} refused (${result.status}): ${result.text}`);
  return result;
}

/** Sign out from the workspace: the account page owns that button. */
export async function signOutWorkspace(page) {
  await openAccountSettings(page);
  await page.until("Boolean(document.querySelector('[data-product-account]'))", { label: "the account page" });
  // The page's own Sign out (the sidebar has none in a product workspace).
  await page.evaluate(`(() => {
    const scope = document.querySelector('[data-product-account]');
    const button = [...scope.querySelectorAll("button")].find(candidate => candidate.textContent.trim() === "Sign out");
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

/** Completes the real email-code form in the account window, then waits for the
 * workspace window that main opens for that account. */
/** Creates an account through the password form of a deployment that asks for
 * no emailed code, then waits for that account's workspace window. */
export async function signUpThroughPasswordGate(gatePage, email, password) {
  await gatePage.click("Create an account", clickButtonByText("Create an account"));
  await gatePage.evaluate(fillField('input[type="email"]', email));
  await gatePage.evaluate(fillField('input[autocomplete="new-password"]', password));
  await gatePage.evaluate(`(() => {
    const repeat = document.querySelectorAll('input[autocomplete="new-password"]')[1];
    if (!repeat) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(repeat, ${JSON.stringify(password)});
    repeat.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await gatePage.click("Create an account", `(() => [...document.querySelectorAll('button[type=submit]')].find(button => !button.disabled))()`);
  await gatePage.until("document.querySelector('[data-product-account-window]')?.dataset.productAccountWindow === 'signed-in'", {
    label: `password sign-up for ${email}`, timeoutMs: 120_000,
  });
  return await workspaceAfterGate(gatePage, email);
}

/** Signs in through the password form itself (the default first screen). */
export async function signInThroughPasswordGate(gatePage, email, password) {
  await gatePage.evaluate(fillField('input[type="email"]', email));
  await gatePage.evaluate(fillField('input[autocomplete="current-password"]', password));
  await gatePage.click("Sign in", `(() => [...document.querySelectorAll('button[type=submit]')].find(button => !button.disabled))()`);
  await gatePage.until("document.querySelector('[data-product-account-window]')?.dataset.productAccountWindow === 'signed-in'", {
    label: `password sign-in for ${email}`, timeoutMs: 120_000,
  });
  return await workspaceAfterGate(gatePage, email);
}

/** The workspace window main opened for a gate that just signed in, proved by
 * that account's own sidebar line. */
async function workspaceAfterGate(gatePage, email) {
  const debugPort = Number(new URL(gatePage.target.webSocketDebuggerUrl.replace(/^ws:/, "http:")).port);
  const deadline = Date.now() + 150_000;
  const tried = new Set();
  while (Date.now() < deadline) {
    const pages = (await listPages(debugPort).catch(() => []))
      .filter(target => /^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/.test(target.url) && !tried.has(target.id));
    for (const target of pages) {
      tried.add(target.id);
      const page = await attachPage(target).catch(() => null);
      if (!page) continue;
      const ok = await page.until("Boolean(window.hezuo?.productAccount)", { label: `${email}'s bridge`, timeoutMs: 15_000 })
        .then(() => page.until(`document.querySelector('[data-sidebar-product-email]')?.textContent?.trim() === ${JSON.stringify(email)}`, {
          label: `${email}'s sidebar`, timeoutMs: 45_000,
        }))
        .then(() => true, () => false);
      if (ok) return { page, url: target.url, workspace: true };
      page.close();
    }
    await sleep(400);
  }
  throw new Error(`no workspace window ever showed ${email}`);
}

export async function signInThroughGate(gatePage, email, mailbox) {
  await gatePage.click("Email me a sign-in code", clickButtonByText("Email me a sign-in code"));
  await gatePage.evaluate(fillField('input[type="email"]', email));
  await gatePage.click("Send code", clickButtonByText("Send code"));
  const code = await mailbox.nextCode();
  await gatePage.until("Boolean(document.querySelector('input[inputmode=\"numeric\"]'))", { label: "the code field" });
  await gatePage.evaluate(fillField('input[inputmode="numeric"]', code));
  await gatePage.click("Verify and sign in", `(() => [...document.querySelectorAll("button[type=submit]")].find(button => !button.disabled))()`);
  await gatePage.until("document.querySelector('[data-product-account-window]')?.dataset.productAccountWindow === 'signed-in'", {
    label: `sign-in for ${email}`, timeoutMs: 120_000,
  });
  const debugPort = Number(new URL(gatePage.target.webSocketDebuggerUrl.replace(/^ws:/, "http:")).port);
  // Sign-out closes the previous workspace, so one of the matching pages belongs to this sign-in; the
  // sidebar's own account line is what proves which (both accounts share the same loopback origin).
  const deadline = Date.now() + 150_000;
  // A closed account's page can linger in the debugger list while its window is torn down; never retry the same target.
  const tried = new Set();
  while (Date.now() < deadline) {
    const pages = (await listPages(debugPort).catch(() => []))
      .filter(target => /^http:\/\/127\.0\.0\.1:\d+\/(\?|$)/.test(target.url) && !tried.has(target.id));
    for (const target of pages) {
      tried.add(target.id);
      const page = await attachPage(target).catch(() => null);
      if (!page) continue;
      const ok = await page.until("Boolean(window.hezuo?.productAccount)", { label: `${email}'s bridge`, timeoutMs: 15_000 })
        .then(() => page.until(`document.querySelector('[data-sidebar-product-email]')?.textContent?.trim() === ${JSON.stringify(email)}`, {
          label: `${email}'s sidebar`, timeoutMs: 45_000,
        }))
        .then(() => true, () => false);
      if (ok) return { page, url: target.url, workspace: true };
      page.close();
    }
    await sleep(400);
  }
  throw new Error(`no workspace window ever showed ${email}`);
}
