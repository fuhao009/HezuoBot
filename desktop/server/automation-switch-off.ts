import type { AppTriggerManager } from "./app-triggers.ts";
import type { CalendarCallManager } from "./calendar-calls.ts";
import type { RoutineManager } from "./routines.ts";
import type { WaitManager } from "./waits.ts";
import type { WebhookManager } from "./webhooks.ts";

export interface AutomationSwitches {
  routines(): Pick<RoutineManager, "listRoutines" | "update"> | null;
  calls(): Pick<CalendarCallManager, "list" | "switchOff"> | null;
  webhooks(): Pick<WebhookManager, "list" | "update"> | null;
  appEvents(): Pick<AppTriggerManager, "list" | "update"> | null;
  waits(): Pick<WaitManager, "all" | "cancel"> | null;
}

/** Switches off enabled automations, optionally restricted to named keys; returns those switched off. */
export async function switchAutomationsOff(automations: AutomationSwitches, only?: ReadonlySet<string>): Promise<string[]> {
  const done: string[] = [];
  const off = async (kind: string, id: string, work: () => unknown) => {
    const key = `${kind}:${id}`;
    if (only && !only.has(key)) return;
    try { await work(); done.push(key); } catch (error) { console.warn(`automations: could not switch ${kind} ${id} off (${(error as Error).message})`); }
  };
  const routines = automations.routines(), calls = automations.calls(), webhooks = automations.webhooks(), appEvents = automations.appEvents(), waits = automations.waits();
  for (const routine of routines?.listRoutines() ?? []) if (routine.enabled) await off("routine", routine.id, () => routines!.update(routine.id, { enabled: false }));
  for (const call of calls?.list() ?? []) if (call.nextRunAt !== null) await off("call", call.id, () => calls!.switchOff(call.id));
  for (const webhook of webhooks?.list() ?? []) if (webhook.enabled) await off("webhook", webhook.id, () => webhooks!.update(webhook.id, { enabled: false }));
  for (const trigger of appEvents?.list() ?? []) if (trigger.enabled) await off("app-event", trigger.id, () => appEvents!.update(trigger.id, { enabled: false }));
  for (const wait of waits?.all() ?? []) await off("wait", wait.id, () => { if (!waits!.cancel(wait.id, wait.botId)) throw new Error("it already ended"); });
  return done;
}

