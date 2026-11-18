
const PHONE_PAIRING_ACTION = "data-phone-pairing-action";

interface PairingRoot {
  scrollIntoView?: (options: ScrollIntoViewOptions) => void;
  querySelector: (selector: string) => { focus: (options?: FocusOptions) => void } | null;
  focus: (options?: FocusOptions) => void;
}

/** Deferred a frame: Settings settles its own scroll position after its sections' effects run. */
export function revealPhonePairing(
  root: PairingRoot | null,
  schedule: (callback: () => void) => unknown = (callback) => window.requestAnimationFrame(callback),
): boolean {
  if (!root) return false;
  schedule(() => {
    root.scrollIntoView?.({ block: "start" });
    (root.querySelector(`[${PHONE_PAIRING_ACTION}]:not([disabled])`) ?? root).focus({ preventScroll: true });
  });
  return true;
}


/** Where a page signed in by the app goes next: a path of this same server. */
export function pairedDestination(search: string): string {
  const params = new URLSearchParams(search);
  const next = params.get("next");
  return next && /^\/(?!\/)/.test(next) && !next.startsWith("/pair") && !/[\\\s]/.test(next) ? next : "/";
}
