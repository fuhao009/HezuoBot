import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";
import type { ApprovalMode } from "../../../../packages/shared/approval-mode";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { Segmented, type SegmentOption } from "./rows";

const ACTS_LABEL: Record<ApprovalMode, () => string> = {
  ask: () => t("botSettings.simple.ask"),
  full: () => t("botSettings.simple.justDoIt"),
  auto: () => t("botSettings.simple.decide"),
  edits: () => t("approvalMode.edits.label"),
  custom: () => t("botPanel.acts.custom"),
};

export function ActsChoice({ bot, derived }: { bot: Bot; derived: ReturnType<typeof useBotSettingsDerived> }) {
  const { dispatch } = useStore();
  const { approvalMode, engine } = derived;
  // Antigravity's old Auto still executes as Ask: show that without changing the saved mode or granting Full.
  const displayedMode: ApprovalMode = engine?.driverKind === "antigravityAgent" && approvalMode === "auto" ? "ask" : approvalMode;
  const options: SegmentOption<ApprovalMode>[] = [
    { value: "ask", label: ACTS_LABEL.ask(), tooltip: t("botSettings.simple.askHint") },
    { value: "full", label: ACTS_LABEL.full(), tooltip: t("botSettings.simple.fullHint") },
    ...(displayedMode === "ask" || displayedMode === "full"
      ? []
      : [{ value: displayedMode, label: ACTS_LABEL[displayedMode](), disabled: true, tooltip: displayedMode === "custom" ? t("botPanel.acts.customHint") : undefined }]),
  ];
  const choose = (mode: ApprovalMode) => {
    if (mode === approvalMode || (mode !== "ask" && mode !== "full")) return;
    dispatch({ type: "updateBot", botId: bot.id, patch: { approvalMode: mode, applyToAllThreads: true } });
  };
  return (
    <Segmented
      attr="data-approval-choice"
      label={t("botSettings.simple.beforeActs", { name: bot.name })}
      value={displayedMode}
      onChange={choose}
      options={options}
    />
  );
}
