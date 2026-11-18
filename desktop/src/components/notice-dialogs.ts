import { useEffect, useState } from "react";
import { SIMPLE_MODE_PROMPT } from "./SimpleModePrompt";

const OTHER_DIALOGS = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-tour-card], [data-cloud-setup-ready]';
const QUEUE_POPUPS = SIMPLE_MODE_PROMPT;

/** Any dialog on screen counts, modal or not, and the card that says a new Cloud is set up; never the queue's own popups. */
export function otherDialogOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>(OTHER_DIALOGS)].some(element => !element.closest(QUEUE_POPUPS) && element.checkVisibility());
}

export function useOtherDialogOpen(watch: boolean): boolean {
  const [, setOpen] = useState(false);
  useEffect(() => {
    if (!watch) return;
    const timer = setInterval(() => setOpen(otherDialogOpen()), 1_000);
    return () => clearInterval(timer);
  }, [watch]);
  return watch && otherDialogOpen();
}
