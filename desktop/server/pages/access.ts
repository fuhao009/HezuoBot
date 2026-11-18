
export const PAGES_TOKEN_PATH = "/api/cloud/pages/token";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type PagesAccess = { kind: "desktop"; url: string; token: string };

/** The headers that prove a request to the Admin's token route comes from this account. */
export function pagesAuthHeaders(access: PagesAccess): Record<string, string> {
  return { authorization: `Bearer ${access.token}` };
}

let desktopPages: { url: string; token: string } | null = null;
/** The desktop is signed in, but its Admin offers no pages for that sign-in yet. */
let desktopPagesNotOffered = false;

/** Security: the pages token goes only to the Admin over https, or to a loopback stand-in in development and tests. */
function adminUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)) ? url.href : null;
  } catch {
    return null;
  }
}

/** `{ type: "hezuo:included-pages", access: { url, token } | null }` from the desktop's main process. True when it
 * was one (then applied), false for any other message; a malformed one throws and changes nothing. */
export function applyIncludedPagesMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "hezuo:included-pages") return false;
  const access = (message as { access?: unknown }).access;
  if (access === null) {
    desktopPages = null;
    desktopPagesNotOffered = (message as { offered?: unknown }).offered === false;
    return true;
  }
  const { url, token } = (access && typeof access === "object" ? access : {}) as { url?: unknown; token?: unknown };
  const target = adminUrl(url);
  if (typeof token !== "string" || !/^hezuo_pd_[A-Za-z0-9_-]{43}$/.test(token) || !target) throw new Error("invalid pages access");
  desktopPages = { url: target, token };
  desktopPagesNotOffered = false;
  return true;
}

/** True when this desktop is signed in but its Admin offers no pages yet: the bot says so instead of asking to sign in. */
export function pagesNotOffered(): boolean {
  return !desktopPages && desktopPagesNotOffered;
}

/** Null when this server is signed in to no Hezuo account. */
export function pagesAccess(): PagesAccess | null {
  return desktopPages ? { kind: "desktop", ...desktopPages } : null;
}
