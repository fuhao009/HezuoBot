import { useEffect, useState } from "react";
import { useStore } from "@/state/store";
import { cornerPopupWaits, firstReplyPending } from "@/lib/corner-popup";
import { launchNotice, markLaunchNotice, nextNotice, SIMPLE_MODE_NOTICE } from "@/lib/notices";
import { useSimpleModePromptSeen } from "@/lib/simple-mode-prompt";
import { welcomeFinishedThisLaunch, type WelcomeViewer } from "@/lib/onboarding";
import { launchDialogShown, markLaunchDialog } from "@/lib/launch-dialogs";
import { useOtherDialogOpen } from "./notice-dialogs";
import { useHezuoWelcomeDue } from "./HezuoWelcome";
import { reportSimpleModePrompt, SimpleModePrompt } from "./SimpleModePrompt";

/** Local UI guidance only. Account, login and welcome flows own their required UI. */
export function AppNotices({ quiet = false, viewer = null }: { quiet?: boolean; viewer?: WelcomeViewer | null; now?: () => number }) {
  const { state } = useStore();
  const hezuo = useHezuoWelcomeDue(viewer);
  const simpleDue = !useSimpleModePromptSeen();
  const simpleBlocked = useOtherDialogOpen(simpleDue) || Boolean(state.liveCall && state.liveCall.status !== "ended");
  const [closed, setClosed] = useState(false);
  const [simpleShown, setSimpleShown] = useState(false);
  const firstChat = firstReplyPending(state);
  const afterWelcome = welcomeFinishedThisLaunch() || launchDialogShown() === "hezuo" || firstChat;
  const waits = cornerPopupWaits(state, { quiet, idle: true, viewer });
  const notice = waits || closed ? null : nextNotice({
    [SIMPLE_MODE_NOTICE]: !simpleDue || afterWelcome === true ? false
      : afterWelcome === null || hezuo.due || simpleBlocked ? null : true,
  }, () => false, launchNotice());

  useEffect(() => {
    if (!notice) return;
    markLaunchNotice(notice);
    if (notice === SIMPLE_MODE_NOTICE) {
      markLaunchDialog("notices");
      if (!simpleShown) {
        setSimpleShown(true);
        reportSimpleModePrompt("shown");
      }
    }
  }, [notice, simpleShown]);

  if (notice === SIMPLE_MODE_NOTICE) return <SimpleModePrompt onClose={() => setClosed(true)} />;
  return null;
}
