import { useState } from "react";
import { Check, Hand, Loader2, LogIn, RefreshCw, X } from "lucide-react";

import type { ComputerHelpRef } from "../../../packages/shared/wire";
import { signInOutcome } from "../../../packages/shared/sign-in-request";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { cancelBrowserTakeover, requestBrowserTakeover } from "@/lib/browser-takeover";
import { answerSignIn, signInHostIsHere } from "@/lib/sign-in";
import { api, type Bot, type Message } from "@/state/store";
import { ASK_CHIP, ASK_CHIP_IDLE, askPrimary, ASK_QUIET_BUTTON, AskCard, AskSettledLine, returnFocusToComposer } from "./AskCard";
import { openProviderDesktop } from "./computer-takeover";

const WHERE = {
  browser: "signIn.where.browser",
  vm: "signIn.where.vm",
  cloud: "signIn.where.cloud",
  local: "signIn.where.local",
  host: "signIn.where.host",
} as const;

export function SignInRequestCard({
  botId,
  botName,
  color,
  threadId,
  message,
}: {
  botId: string;
  botName: string;
  color?: Bot["color"];
  threadId: string;
  message: Message;
}) {
  const card = message.signIn!;
  const [pending, setPending] = useState<"done" | "cancel" | null>(null);
  const [explained, setExplained] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const error = localError ?? card.error;
  const outcome = signInOutcome(card);
  const ref = { botId, threadId, messageId: message.id, place: card.place };
  const here = signInHostIsHere();


  const answer = async (choice: "done" | "cancel") => {
    if (pending) return;
    setPending(choice);
    setLocalError(null);
    try {
      if (choice === "cancel" && card.place === "browser") await cancelBrowserTakeover({ ...ref, place: "browser" });
      await answerSignIn(ref, choice);
      returnFocusToComposer();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const stopped = card.stopped === true;

  if (card.answeredInChat) {
    return (
      <AskSettledLine ariaLabel={t("signIn.title")}>
        <span className="text-ink-secondary">{card.site}</span>
        <span> · {t("signIn.answeredInChat")}</span>
      </AskSettledLine>
    );
  }

  if (card.superseded || (stopped && !outcome)) {
    return (
      <AskSettledLine icon={<X size={13} />} ariaLabel={t("signIn.title")}>
        <span className="text-ink-secondary">{card.site}</span>
        <span> · {t(card.superseded ? "signIn.superseded" : "chat.turnStopped")}</span>
      </AskSettledLine>
    );
  }

  if (outcome) {
    const retry = !card.resumed && !stopped && error ? (
      <button type="button" onClick={() => void answer(outcome === "done" ? "done" : "cancel")} disabled={pending !== null}
        className={cn(ASK_QUIET_BUTTON, "text-accent-text")}>
        {pending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        {t("signIn.retry")}
      </button>
    ) : undefined;
    return (
      <AskSettledLine
        ariaLabel={t("signIn.title")}
        icon={outcome === "cancelled" ? <X size={13} className="text-ink-tertiary" /> : card.resumed || stopped ? undefined : error ? <LogIn size={13} /> : <Loader2 size={13} className="animate-spin" />}
        action={retry}
        detail={error && <p role="alert" className="ms-[19px] mt-1 text-[12px] text-danger">{error}</p>}
      >
        <span className="text-ink-secondary">{card.place === "browser" && outcome === "done"
          ? t("signIn.handedBack", { name: botName })
          : t(outcome === "done" ? "signIn.settled.done" : "signIn.settled.cancelled", { site: card.site })}</span>
      </AskSettledLine>
    );
  }

  const where = WHERE[card.place === "local" && !here ? "host" : card.place];
  const open = async () => {
    setLocalError(null);
    try {
      if (card.place === "browser") await requestBrowserTakeover({ ...ref, place: "browser" }, botName, setLocalError);
      else if (card.place === "local") setExplained(true);
      else {
        const lease = crypto.randomUUID();
        await openProviderDesktop({
          botId, title: t("signIn.windowTitle", { name: botName }), held: false,
          request: action => api(`/api/bots/${encodeURIComponent(botId)}/computer/control`, { method: "POST", body: JSON.stringify({ action, controlLeaseId: lease }) }),
          join: signal => api(`/api/bots/${encodeURIComponent(botId)}/${card.place === "vm" ? "local-computer/join" : "computer/join"}?threadId=${encodeURIComponent(threadId)}&controlLeaseId=${encodeURIComponent(lease)}`, { method: "POST", signal }),
          current: () => true,
        });
      }
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return (
    <AskCard
      ariaLabel={t("signIn.cardLabel", { name: botName, site: card.site })}
      icon={<LogIn size={15} />}
      title={t("signIn.title")}
      footer={<>
        <button type="button" onClick={() => void open()} disabled={pending !== null} {...askPrimary(color)}>
          <Hand size={14} />
          {t(card.place === "browser" ? "signIn.takeover" : "signIn.open")}
        </button>
        <button type="button" onClick={() => void answer("cancel")} disabled={pending !== null} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
          {pending === "cancel" ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
          {t("signIn.cancel")}
        </button>
        {card.place !== "browser" && <button type="button" onClick={() => void answer("done")} disabled={pending !== null} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
          <Check size={14} />{t("signIn.done")}
        </button>}
      </>}
    >
      <p className="text-[14px] text-ink" data-testid="sign-in-site">{t("signIn.takeoverPrompt", { name: botName, site: card.site })}</p>
      {card.place !== "browser" && <p className="mt-2 text-[13px] text-ink-secondary">{t(where, { name: botName })}</p>}
      {explained && <p role="note" className="mt-1.5 text-[13px] text-ink">{t(here ? "signIn.local.explain" : "signIn.local.explainHost", { name: botName })}</p>}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </AskCard>
  );
}

export function SignInBanner({
  help,
  askerName,
  takeControl,
  onError,
}: {
  help: ComputerHelpRef;
  askerName: string;
  takeControl?: { onClick: () => void; disabled?: boolean; pending?: boolean };
  onError?: (message: string | null) => void;
}) {
  const [pending, setPending] = useState<"done" | "cancel" | null>(null);
  const answer = async (choice: "done" | "cancel") => {
    if (pending) return;
    setPending(choice);
    onError?.(null);
    try { await answerSignIn(help, choice); }
    catch (cause) { onError?.(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  };
  return (
    <div className="mt-3 rounded-xl border border-warning/25 bg-warning/10 p-4 text-start" data-testid="sign-in-banner">
      <div className="text-[13px] leading-relaxed text-warning">
        <b>{askerName}</b> {t("signIn.banner", { site: help.site })}
      </div>
      {help.place === "local" && (
        <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {t(signInHostIsHere() ? "signIn.where.local" : "signIn.where.host", { name: askerName })}
        </div>
      )}
      <div className="mt-2 flex gap-2">
        {takeControl && (
          <button
            type="button"
            onClick={takeControl.onClick}
            disabled={takeControl.disabled}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-50"
          >
            {takeControl.pending ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
            {t("computer.takeControl")}
          </button>
        )}
        <button
          type="button"
          onClick={() => void answer("done")}
          disabled={pending !== null}
          className={cn("flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium disabled:opacity-50",
            takeControl ? "bg-control text-ink hover:bg-raised-hover" : "flex-1 bg-accent text-accent-ink hover:brightness-110")}
        >
          {pending === "done" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {t("signIn.done")}
        </button>
        <button
          type="button"
          onClick={() => void answer("cancel")}
          disabled={pending !== null}
          className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {t("signIn.cancel")}
        </button>
      </div>
    </div>
  );
}
