import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, Loader2, XCircle } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { partlyDone, routineRunLabel } from "@/lib/routine-display";
import { isRoutineProblemRun, type RoutineRun } from "@/lib/routines";
import { durationLabel, niceTime } from "@/lib/schedule-label";

export function DrawerField({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">{label}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function runDurationLabel(run: RoutineRun): string | null {
  if (run.startedAt == null || run.finishedAt == null || run.finishedAt < run.startedAt) return null;
  const seconds = Math.round((run.finishedAt - run.startedAt) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return durationLabel(Math.round(seconds / 60));
}

export function RecentRunRow({ run, current, onOpen }: { run: RoutineRun; current: boolean; onOpen: () => void }) {
  const at = run.startedAt ?? run.scheduledFor;
  const duration = runDurationLabel(run);
  const ok = run.status === "completed" && (!run.goalStatus || run.goalStatus === "completed");
  const problem = isRoutineProblemRun(run) || run.goalStatus === "failed" || run.goalStatus === "blocked";
  const active = ["queued", "running", "waiting"].includes(run.status);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("routines.openRun", { name: run.routineName, status: routineRunLabel(run) })}
      aria-current={current || undefined}
      className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-raised", current && "bg-raised")}
    >
      {ok
        ? <CheckCircle2 size={14} className="shrink-0 text-success" aria-hidden="true" />
        : problem
          ? partlyDone(run) ? <CircleAlert size={14} className="shrink-0 text-warning" aria-hidden="true" /> : <XCircle size={14} className="shrink-0 text-danger" aria-hidden="true" />
          : active
            ? <Loader2 size={14} className="shrink-0 animate-spin text-accent" aria-hidden="true" />
            : <CircleAlert size={14} className="shrink-0 text-ink-tertiary" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-ink-secondary">{niceTime(at)}{duration ? ` · ${duration}` : ""}</span>
    </button>
  );
}
