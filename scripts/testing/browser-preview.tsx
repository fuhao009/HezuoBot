import { createRoot } from "react-dom/client";
import { BrowserPanel } from "../../desktop/src/components/BrowserPanel";
import { ChatView } from "../../desktop/src/components/ChatView";
import { ComputerPanel } from "../../desktop/src/components/ComputerPanel";
import { StoreProvider, useStore } from "../../desktop/src/state/store";
import { applySkin } from "../../desktop/src/lib/skins";
import "../../desktop/src/styles.css";

function Fixture() {
  const { state } = useStore();
  const bot = state.bots[0];
  if (!bot) return <main>Loading isolated fixture…</main>;
  if (new URLSearchParams(location.search).has("takeover")) return <main className="flex h-screen bg-app">
    <div className="min-w-0 flex-1"><ChatView bot={bot} /></div>
    {state.computerOpen && <ComputerPanel key={bot.id} bot={bot} />}
  </main>;
  return <main className="flex h-screen bg-app p-3 sm:p-6"><BrowserPanel bot={bot} /></main>;
}
applySkin("midnight");
createRoot(document.getElementById("root")!).render(<StoreProvider><Fixture /></StoreProvider>);
