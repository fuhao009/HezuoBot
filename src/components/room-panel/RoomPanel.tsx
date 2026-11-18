import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { ChevronRight, FileText, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { closeRoomPanel } from "@/lib/room-panel";
import { useStore, type Bot, type Group } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { useCaptionChrome } from "../DesktopCapabilities";
import { useBulletinEditor } from "../RoomBulletin";
import { buttonCls, Card, ColRow, roundButtonCls, rowCls, RowText } from "../bot-panel/rows";
import { sidePanelCls } from "../bot-panel/side-panel";

function RoomHero({ group, members }: { group: Group; members: Bot[] }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div data-room-panel-faces className="mt-0.5 flex -space-x-3">
        {members.slice(0, 3).map((member) => (
          <BotAvatar key={member.id} bot={member} state="happy" size={52} animated={false} />
        ))}
      </div>
      <h2 id="room-panel-title" className="mt-2.5 max-w-full truncate px-1.5 text-[18px] font-semibold text-ink">{group.name}</h2>
      {group.description && <p className="mt-px line-clamp-2 max-w-full text-[13px] text-ink-secondary">{group.description}</p>}
    </div>
  );
}

function InstructionsRow({ group }: { group: Group }) {
  const bulletin = useBulletinEditor(group);
  const editRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (bulletin.open || !refocus.current) return;
    refocus.current = false;
    editRef.current?.focus();
  }, [bulletin.open]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
    }
    if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) refocus.current = true;
    bulletin.onKeyDown(event);
  };

  if (bulletin.open) {
    return (
      <ColRow data-panel-row="instructions">
        <RowText title={t("room.panel.instructions")} />
        <textarea
          autoFocus
          dir="auto"
          aria-label={t("room.panel.instructions")}
          value={bulletin.draft}
          onChange={(event) => bulletin.setDraft(event.target.value)}
          onBlur={bulletin.save}
          onKeyDown={onKeyDown}
          placeholder={t("room.bulletin.placeholder")}
          rows={6}
          className="w-full resize-y rounded-lg border border-hairline bg-inset px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent-border"
        />
        <div className="flex justify-end">
          <button
            type="button"
            data-panel-done="instructions"
            // Keeps the field focused, so its blur does not save before Done does.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              refocus.current = true;
              bulletin.save();
            }}
            className={buttonCls}
          >
            {t("botSettings.simple.done")}
          </button>
        </div>
      </ColRow>
    );
  }
  const firstLine = group.bulletin.split("\n")[0]?.trim();
  return (
    <button
      ref={editRef}
      type="button"
      data-panel-edit="instructions"
      aria-label={`${t("botSettings.simple.edit")}: ${t("room.panel.instructions")}`}
      onClick={bulletin.start}
      className={cn(rowCls, "w-full text-left hover:bg-ink/[0.03]")}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ink/[0.05] text-ink-secondary max-md:size-8 max-md:rounded-full" aria-hidden="true">
        <FileText size={15} />
      </span>
      <RowText
        title={t("room.panel.instructions")}
        hint={<span dir="auto" className="line-clamp-1">{firstLine || t("room.panel.instructionsHint")}</span>}
      />
      <ChevronRight size={15} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
    </button>
  );
}

export function RoomPanel({ group, overlay = false }: { group: Group; overlay?: boolean }) {
  const { state } = useStore();
  const { dragProps } = useCaptionChrome();
  const dialogRef = useRef<HTMLElement>(null);
  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot)),
    [group.memberIds, state.bots],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) return;
      event.preventDefault();
      closeRoomPanel({ refocus: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside
      ref={dialogRef}
      role="dialog"
      aria-labelledby="room-panel-title"
      tabIndex={-1}
      data-room-panel
      className={sidePanelCls(overlay, true)}
    >
      <div {...dragProps} className="flex h-[52px] shrink-0 items-center justify-end gap-2 px-3.5">
        <button type="button" onClick={() => closeRoomPanel({ refocus: true })} aria-label={t("botSettings.simple.close")} className={roundButtonCls}>
          <X size={16} className="pointer-events-none" />
        </button>
      </div>

      <div className="@container relative min-h-0 flex-1 overflow-y-auto px-5 pb-7">
        <RoomHero group={group} members={members} />
        <Card>
          <InstructionsRow group={group} />
        </Card>
      </div>
    </aside>
  );
}
