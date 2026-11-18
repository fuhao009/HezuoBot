// Read before main.tsx's first-paint writes: applySkin stamps hezuo-skin on every boot.
const PRIOR_RUN_KEYS = ["hezuo-skin", "hezuo-installed", "hezuo-email-gate", "hezuo-drafts", "hezuo-show-threads"];

export function hasPriorRun(store: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return PRIOR_RUN_KEYS.some((key) => store?.getItem(key) != null);
  } catch {
    return false;
  }
}
