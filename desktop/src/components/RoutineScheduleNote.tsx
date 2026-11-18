import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { localDesktopPage } from "./onboarding/WelcomeGate";

export type SchedulePlace = { kind: "cloud" } | { kind: "server" } | { kind: "local" };

/** Scheduling runs where the current workspace runs, without a purchase flow. */
export function schedulePlace({ cloudHome, local }: { cloudHome: boolean; local: boolean }): SchedulePlace {
  if (cloudHome) return { kind: "cloud" };
  return { kind: local ? "local" : "server" };
}

export function RoutineScheduleNote() {
  const { state } = useStore();
  const local = localDesktopPage() && window.hezuo?.remoteClient?.active !== true;
  const place = schedulePlace({ cloudHome: state.config?.cloudHome === true, local });
  return <p data-routine-schedule-note={place.kind} className="text-[11px] leading-relaxed text-ink-secondary">
    {t(place.kind === "cloud" ? "routines.scheduleNote.cloud" : place.kind === "server" ? "routines.scheduleNote.server" : "routines.scheduleNote.local")}
  </p>;
}
