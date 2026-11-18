import { hintSeen, hintSeenPatch, type OnboardingStatus } from "@/lib/onboarding";

export const SIMPLE_MODE_NOTICE = "simple-mode-prompt";

/** Only local guidance participates in the launch queue. */
export const NOTICES = [SIMPLE_MODE_NOTICE] as const;
export type NoticeId = (typeof NOTICES)[number];
export type NoticeFacts = Record<NoticeId, boolean | null>;

export function nextNotice(facts: NoticeFacts, seen: (id: NoticeId) => boolean, launch: NoticeId | null = null): NoticeId | null {
  for (const id of NOTICES) {
    if (seen(id) || (launch !== null && id !== launch)) continue;
    if (facts[id] === null) return null;
    if (facts[id]) return id;
  }
  return null;
}

const LAUNCH_KEY = "hezuo.launch.notice";
let launchMemory: NoticeId | null = null;
const isNotice = (id: unknown): id is NoticeId => (NOTICES as readonly unknown[]).includes(id);

/** Retired campaigns in session storage do not block local guidance. */
export function launchNotice(): NoticeId | null {
  try {
    const id = sessionStorage.getItem(LAUNCH_KEY);
    if (isNotice(id)) return id;
  } catch {}
  return launchMemory;
}

export function markLaunchNotice(id: NoticeId): void {
  if (launchNotice()) return;
  try {
    sessionStorage.setItem(LAUNCH_KEY, id);
  } catch {
    launchMemory = id;
  }
}

export function noticeSeen(record: OnboardingStatus | undefined, id: string): boolean {
  try {
    return hintSeen(record, id) || localStorage.getItem(id) === "1";
  } catch {
    return hintSeen(record, id);
  }
}

export function dismissNotice(record: OnboardingStatus | undefined, id: string): { onboarding: { hintsSeen: string[] } } | null {
  try { localStorage.setItem(id, "1"); } catch {}
  return hintSeenPatch(record, id);
}
