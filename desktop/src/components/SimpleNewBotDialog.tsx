import { useEffect, useRef, useState } from "react";
import { BOT_PROFILE_LIMITS } from "../../../packages/shared/bot-profile";
import { api, BotEditorStore, useStore, type Action } from "@/state/store";
import type { BotCreationDraft } from "@/lib/bot-creation-draft";
import { makeNewBot, newBotDraft, validNewBotProfile } from "@/lib/new-bot";
import { utf8Bytes } from "@/lib/soul";
import { t } from "@/lib/i18n";
import { useShowThreads } from "@/lib/thread-preferences";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";
import { BotEditorContext } from "./bot-settings/BotEditorContext";
import { inputCls } from "./bot-settings/field";

export function SimpleNewBotDialog({ action, onClose }: {
  action: Extract<Action, { type: "newBot" }>;
  onClose: () => void;
}) {
  const parent = useStore();
  const { state, dispatch } = parent;
  const showThreads = useShowThreads();
  const [, render] = useState(0);
  const [draft, setDraft] = useState<BotCreationDraft | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const initialBots = useRef(state.bots);
  useEffect(() => {
    let cancelled = false;
    let loaded: BotCreationDraft | undefined;
    void newBotDraft(action.section, initialBots.current, () => render(value => value + 1)).then(value => {
      loaded = value;
      if (cancelled) value.dispose();
      else setDraft(value);
    }).catch(cause => {
      if (cancelled) return;
      const message = t("newBot.failed", { error: cause instanceof Error ? cause.message : String(cause) });
      setError(message);
      action.onError?.(message);
    });
    return () => { cancelled = true; loaded?.dispose(); };
  }, [action]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const root = dialog.current;
      if (!root || (event.target instanceof Node && !root.contains(event.target))) return;
      if (root.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (event.key === "Escape" && !savingRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const controls = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]')]
        .filter(control => !control.closest('[hidden], fieldset:disabled'));
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); root.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus(); };
  }, []);
  const save = async () => {
    if (!draft || savingRef.current || !validNewBotProfile(draft.bot)) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    dispatch({ type: "botCreationPending", on: true });
    try {
      const created = await makeNewBot({ ...action, onError: message => { setError(message); action.onError?.(message); } }, state.bots, dispatch, showThreads, api, draft);
      if (created) closeRef.current();
    } finally {
      savingRef.current = false;
      setSaving(false);
      dispatch({ type: "botCreationPending", on: false });
    }
  };
  const bot = draft?.bot;
  const bytes = utf8Bytes(bot?.soul ?? "");
  const tooLong = bytes > BOT_PROFILE_LIMITS.soul;
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 sm:p-5">
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("sidebar.newBot")} aria-busy={saving} tabIndex={-1}
      className="flex max-h-[94dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none">
      <h2 className="border-b border-hairline/40 px-5 py-4 text-lg font-semibold text-ink">{t("sidebar.newBot")}</h2>
      <div className="min-h-0 overflow-y-auto p-5">
        {!draft && !error && <p role="status">{t("newBot.loading")}</p>}
        {draft && bot && <BotEditorStore value={{ ...parent, flushBotPatches: async () => draft.bot }}><BotEditorContext.Provider value={{ request: draft.request, draft: true, uploadAvatar: draft.uploadAvatar }}>
          <fieldset disabled={saving} className="min-w-0 space-y-4">
            <BotProfileAvatarCard bot={bot} activeState="idle" mascotMotion={null} allowGeneration={false} onPatch={patch => draft.patch(patch)} />
            <label className="block text-sm text-ink-secondary">{t("newBot.name")}
              <input data-new-bot-name required value={bot.name} maxLength={BOT_PROFILE_LIMITS.name} className={`${inputCls} mt-1.5 w-full`}
                onChange={event => draft.patch({ name: event.target.value })} />
            </label>
            <label className="block text-sm text-ink-secondary">{t("newBot.prompt")}
              <textarea data-new-bot-soul rows={5} value={bot.soul} aria-invalid={tooLong} aria-describedby="new-bot-soul-limit" className={`${inputCls} mt-1.5 w-full resize-y`}
                onChange={event => draft.patch({ soul: event.target.value })} />
            </label>
            <p id="new-bot-soul-limit" role={tooLong ? "alert" : undefined} className={tooLong ? "text-sm text-danger" : "text-xs text-ink-tertiary"}>
              {t(tooLong ? "newBot.promptTooLong" : "newBot.promptBytes", { bytes, limit: BOT_PROFILE_LIMITS.soul })}
            </p>
          </fieldset>
        </BotEditorContext.Provider></BotEditorStore>}
      </div>
      {error && <p role="alert" className="px-5 pb-3 text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2 border-t border-hairline/40 px-5 py-3">
        <button type="button" disabled={saving} onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-ink-secondary hover:bg-control disabled:opacity-40">{t("common.cancel")}</button>
        <button type="button" data-new-bot-create disabled={saving || !bot || !validNewBotProfile(bot)} onClick={() => void save()}
          className="ui-button-primary rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-40">{t("newBot.create")}</button>
      </div>
    </div>
  </div>;
}
