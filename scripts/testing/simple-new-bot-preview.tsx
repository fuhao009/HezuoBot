import React, { useState } from "react";
import type {} from "vite/client";
import { createRoot } from "react-dom/client";
import { BotAvatar } from "../../desktop/src/components/Avatar";
import { SimpleNewBotDialog } from "../../desktop/src/components/SimpleNewBotDialog";
import { StoreProvider, useStore, type Bot } from "../../desktop/src/state/store";
import { applySkin, readSkin } from "../../desktop/src/lib/skins";
import { loadLocale } from "../../desktop/src/lib/i18n";
import "../../desktop/src/styles.css";

function Fixture() {
  const { state, dispatch } = useStore();
  const [created, setCreated] = useState<Bot | null>(null);
  const [error, setError] = useState("");
  const selected = state.bots.find(bot => bot.id === state.selectedId);
  const open = () => {
    setError("");
    dispatch({ type: "newBot", onCreated: setCreated, onError: setError });
  };
  return <main className="min-h-screen bg-panel p-8 text-ink">
    <h1 className="mb-4 text-xl font-semibold">Isolated new Bot verification</h1>
    <button type="button" data-fixture-new-bot onClick={open} className="ui-button-primary rounded-lg bg-accent px-4 py-2 text-white">新建机器人</button>
    <dl className="my-6 space-y-2">
      <div><dt>Bot count</dt><dd data-fixture-bot-count>{state.bots.length}</dd></div>
      <div><dt>Selected Bot</dt><dd data-fixture-selected-bot data-bot-id={state.selectedId}>{selected?.name ?? "None"}</dd></div>
      <div><dt>Active view</dt><dd data-fixture-active-view>{state.activeView}</dd></div>
      <div><dt>Creation pending</dt><dd data-fixture-saving>{String(state.botCreationPending)}</dd></div>
    </dl>
    {error && <p role="alert">{error}</p>}
    {created && <section aria-label="Created Bot" data-fixture-created-bot data-bot-id={created.id} className="mb-6 rounded-xl border border-hairline p-4">
      <h2 className="text-lg">Created Bot</h2>
      <BotAvatar bot={created} size={72} />
      <dl className="space-y-2">
        <div><dt>Name</dt><dd data-fixture-created-name>{created.name}</dd></div>
        <div><dt>Color</dt><dd data-fixture-created-color>{created.color}</dd></div>
        <div><dt>Body</dt><dd data-fixture-created-body>{created.mascotBody ?? "cursor"}</dd></div>
        <div><dt>Avatar URL</dt><dd data-fixture-created-avatar>{created.avatarUrl ?? ""}</dd></div>
        <div><dt>Standing instructions</dt><dd><pre data-fixture-created-soul className="whitespace-pre-wrap">{created.soul ?? ""}</pre></dd></div>
      </dl>
    </section>}
    <section aria-label="Workspace Bots">
      <h2 className="mb-3 text-lg">Workspace Bots</h2>
      <ul data-fixture-bots className="space-y-2">{state.bots.map(bot => <li key={bot.id} data-bot-id={bot.id} aria-current={state.selectedId === bot.id ? "true" : undefined} className="flex items-center gap-3">
        <BotAvatar bot={bot} size={40} /><span>{bot.name}</span>
      </li>)}</ul>
    </section>
    {state.pendingNewBot && <SimpleNewBotDialog action={state.pendingNewBot} onClose={() => dispatch({ type: "closeNewBot" })} />}
  </main>;
}

await loadLocale("zh");
applySkin(readSkin());
const root = createRoot(document.getElementById("root")!);
root.render(<StoreProvider><Fixture /></StoreProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
