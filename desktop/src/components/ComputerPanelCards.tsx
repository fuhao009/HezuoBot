import { CalendarClock, ChevronRight, Globe } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { routineRunLabel, routineRunTone } from "@/lib/routine-display";
import type { RoutineRun } from "@/lib/routines";
import { Switch } from "./SettingsPrimitives";

export function ComputerBrowserSwitchRow({
  botName,
  canTurnOn,
  unavailableReason,
  enabled,
  turningOn,
  onToggle,
}: {
  botName: string;
  canTurnOn: boolean;
  unavailableReason: string | null | undefined;
  enabled: boolean;
  turningOn: boolean;
  onToggle: () => void;
}) {
  return (
    <div data-testid="browser-switch-row" className="mb-3 flex items-center gap-3 rounded-xl bg-card px-3 py-2.5">
      <Globe size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{t("computer.browserSwitch.title", { name: botName })}</div>
        {!canTurnOn && <div className="text-[12px] text-ink-secondary">{unavailableReason}</div>}
      </div>
      <Switch
        checked={enabled}
        disabled={turningOn || (!enabled && !canTurnOn)}
        aria-label={t("computer.browserSwitch.title", { name: botName })}
        onClick={onToggle}
      />
    </div>
  );
}

export function ComputerRoutinesCard({
  count,
  activeRun,
  onOpen,
}: {
  count: number;
  activeRun: RoutineRun | undefined;
  onOpen: () => void;
}) {
  return (
    <button type="button" onClick={onOpen} className="mt-4 flex w-full items-start gap-3 rounded-xl bg-card p-4 text-left hover:bg-raised">
      <CalendarClock size={17} className="mt-0.5 shrink-0 text-accent" />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-ink">{t("computer.tab.routines")} <span className="ml-1 text-[11px] text-ink-secondary">{count}</span></span>
        <span className={cn("mt-1 block truncate text-[12px]", activeRun ? routineRunTone(activeRun) : "text-ink-secondary")}>{activeRun ? `${activeRun.routineName} · ${routineRunLabel(activeRun)}` : t("computer.routines.openTitle")}</span>
      </span>
      <ChevronRight size={14} className="shrink-0 text-ink-secondary rtl:-scale-x-100" aria-hidden="true" />
    </button>
  );
}
