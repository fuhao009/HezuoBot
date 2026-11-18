import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Loader2, Menu } from "lucide-react";
import { openBot, StoreProvider, useStore } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { useWelcomeViewer, WelcomeGate } from "@/components/onboarding/WelcomeGate";
import { HezuoWelcome } from "@/components/HezuoWelcome";
import { spotlightsQuiet, type WelcomeViewer } from "@/lib/onboarding";
import { FirstConversationTour } from "@/components/onboarding/FirstConversationTour";
import { GuidedTour } from "@/components/onboarding/GuidedTour";
import { LiveCallHost } from "@/components/LiveCallHost";
import { ThreadRefsProvider } from "@/components/ThreadRefs";
import { initAnalytics } from "@/lib/analytics";
import { parseComputerHelp } from "@/lib/computer-control";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { PRODUCT_MID_LAYOUT, SIDEBAR_AND_PANEL_FIT, TWO_SIDE_PANELS_FIT, useMediaQuery } from "@/lib/use-media-query";
import { preloadConnectedApps } from "@/lib/connected-apps";
import {
  KeyboardShortcutsModal, LocalVmWorkspace,
  PluginsPanel, preloadScreens, RoomPanel, SettingsModal, TeamMapPage, TriggersPage,
} from "@/components/lazy-screens";
import { SimpleNewBotDialog } from "@/components/SimpleNewBotDialog";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useRoomPanelShown } from "@/lib/room-panel";
import { WorkspaceBackupRecovery } from "@/components/WorkspaceBackupSettings";
import { NotificationRail, NotificationsPanel } from "@/components/NotificationsPanel";
import { useNotificationFeed } from "@/lib/notification-preferences";
import { AppNotices } from "@/components/AppNotices";
import { LiveConnectionStrip } from "@/components/LiveConnectionStrip";
import { useTeamChats } from "@/state/team-chats";
import { needsYouVersion, useTeamPeopleLoader } from "@/state/team-people";
import { inboxVersion, useInboxLoader, useInboxPanel } from "@/state/inbox";
import { InboxPanel } from "@/components/inbox/InboxPanel";
import { DesktopCapabilitiesProvider, useCaptionChrome, useDesktopCapabilities, WindowDragStrip, windowFramed } from "@/components/DesktopCapabilities";
import { WindowCaptionButtons } from "@/components/WindowCaptionButtons";
import { WindowFrameBar } from "@/components/WindowFrameBar";
import { cn } from "@/lib/cn";
import { NoEngines } from "@/components/NoEngines";
import { EmptyChatShell } from "@/components/onboarding/EmptyChatShell";
import { CommandPalette } from "@/components/CommandPalette";
import { ProductAccountGate } from "@/components/ProductAccountGate";
import { isProductWorkspace } from "@/lib/product-workspace";
import { useProductAccount } from "@/lib/use-product-account";
import { t } from "@/lib/i18n";
import { shouldOpenKeyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { effectiveLanguage, useLanguageChoice, usePageLanguage } from "@/lib/language-preference";
import { botUnreadCount, showBrowserUnread } from "@/lib/bot-unread";
import { takeConnectRequest } from "@/lib/connect-link";
import { useExternalChatLinks } from "@/hooks/use-external-chat-links";
import { useUsageSnapshot } from "@/hooks/use-usage-snapshot";
import { useReadShownChatOnFocus } from "@/hooks/use-read-shown-chat";
import { usePresence } from "@/hooks/use-presence";
import { ChatNotice } from "@/components/ChatErrorBanner";
import { loadingLine } from "@/lib/app-loading";
import { useAiSwitchKeeper } from "@/lib/ai-switch";
import { useChiefStepOpen } from "@/lib/default-bot";
import { SESSION_ENDED_REASON, useSessionEnded } from "@/lib/session-ended";
import { PairPage } from "./pair/PairPage";
import { WebPanelPage } from "@/components/WebPanelPage";

const BotSettingsDialog = lazy(() => import("@/components/BotSettingsDialog").then((module) => ({ default: module.BotSettingsDialog })));

function Shell({ viewer }: { viewer: WelcomeViewer | null }) {
  const { state, dispatch } = useStore();
  useTeamChats(state.config);
  useTeamPeopleLoader(state.config, needsYouVersion(state.bots, state.groups, state.notifications));
  const inbox = inboxVersion(state.bots);
  useInboxLoader(inbox);
  const inboxShown = useInboxPanel().open && inbox !== null;
  // A Switch AI pick lands once its stopped turn's chat is idle, wherever the person is by then.
  useAiSwitchKeeper({ bots: state.bots, dispatch });
  const showThreads = useShowThreads();
  const { capabilities } = useDesktopCapabilities();
  const captionChrome = useCaptionChrome();
  const unreadCount =
    state.bots.filter((bot) => !bot.hidden).reduce((sum, bot) => sum + botUnreadCount(bot), 0) +
    state.groups.filter((group) => group.unread).length;
  const remoteClient = window.hezuo?.remoteClient?.active === true;
  const twoSidePanelsFit = useMediaQuery(TWO_SIDE_PANELS_FIT, true);
  const sidebarAndPanelFit = useMediaQuery(SIDEBAR_AND_PANEL_FIT, true);
  const productMid = useMediaQuery(PRODUCT_MID_LAYOUT, true);
  useEffect(() => {
    if (!window.hezuo?.environments) return;
    const open = (computerId?: string | null) => {
      if (computerId) {
        const target = new URL(window.location.href);
        target.searchParams.set("share-computer", computerId);
        window.history.replaceState(null, "", `${target.pathname}${target.search}${target.hash}`);
      }
      dispatch({ type: "toggleAppSettings", open: true, section: "desktopWorkspaces" });
    };
    const url = new URL(window.location.href);
    const requestedSettings = url.searchParams.get("desktop-settings");
    if (requestedSettings === "workspaces" || (requestedSettings === "organization" && window.hezuo.organization && !remoteClient)) {
      url.searchParams.delete("desktop-settings");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      if (requestedSettings === "organization") dispatch({ type: "toggleAppSettings", open: true, section: "organization" });
      else open();
    }
    return window.hezuo.environments.onOpenSettings?.(open);
  }, [dispatch]);
  useEffect(() => { // A bot's link to a connection that needs the person on My Cloud opens the page that connects it.
    const request = takeConnectRequest(window.location.href);
    if (!request) return;
    window.history.replaceState(null, "", request.rest);
    dispatch("section" in request ? { type: "toggleAppSettings", open: true, section: request.section } : { type: "togglePlugins", open: true, surface: request.surface });
  }, [dispatch]);
  useExternalChatLinks(state, dispatch);
  usePresence(state, dispatch);
  const [drawerOpen, setDrawerOpen] = useState(false);
  usePageLanguage(effectiveLanguage(useLanguageChoice(), state.config?.language));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [localVmWorkspaceBotId, setLocalVmWorkspaceBotId] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const previousViewRef = useRef(state.activeView);
  const calendarOriginRef = useRef<"chat" | "team-map" | "web-panel">("chat");
  const loading = loadingLine({ connected: state.connected, hydrated: state.hydrated === true, developer: import.meta.env.DEV });
  // A managed product workspace: no engine picker, no personal key, and no first-run tour in front of the chat. The
  // bridge is what a packaged account build has before the workspace server reports its config, so it also covers the
  // starting window instead of showing the ordinary onboarding under it.
  const product = isProductWorkspace(state.config?.productManaged);
  const account = useProductAccount();
  const group = state.groups.find((g) => g.id === state.selectedId);
  const chiefStep = useChiefStepOpen() && !product;
  const bot = group || chiefStep ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);
  const notificationFeed = useNotificationFeed() && !remoteClient;
  const advanced = useAdvancedMode();
  const roomPanelOpen = useRoomPanelShown({ group, state, simple: !advanced && !remoteClient });
  const sidePanelOpen = roomPanelOpen || (notificationFeed && state.notificationsOpen) || inboxShown;
  const collapseSidebar = !product && sidePanelOpen && !sidebarAndPanelFit;
  const calendarFocus = state.activeView === "routines" && state.routinesFocus.view === "calendar";

  // A product account never picks an engine: an empty engine list is its normal state, not a setup step. The gate below
  // owns the signed-out screen, so a signed-in workspace is always allowed to reach its chat.
  const noEngines =
    !product &&
    state.connected &&
    state.instances.length > 0 &&
    !state.instances.some((i) => i.snapshot.state === "available");
  const productGate = product && account.auth !== "signed_in";
  const productDrawer = product && !productMid;
  const openProductDrawer = useCallback(() => {
    setDrawerOpen(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || state.shortcutsOpen) return;
      if (shouldOpenKeyboardShortcuts(e)) {
        e.preventDefault();
        dispatch({ type: "toggleShortcuts", open: true });
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const bots = state.bots.filter((b) => !b.hidden);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "newBot" });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          openBot(dispatch, target, showThreads);
        }
      } else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
        const idx = bots.findIndex((b) => b.id === state.selectedId);
        const next = bots[(idx + (e.key === "]" ? 1 : -1) + bots.length) % bots.length];
        if (next) {
          e.preventDefault();
          openBot(dispatch, next, showThreads);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.selectedId, state.shortcutsOpen, showThreads, dispatch]);

  useReadShownChatOnFocus();
  useEffect(() => {
    if (window.hezuo?.setUnreadCount) window.hezuo.setUnreadCount(unreadCount);
    else showBrowserUnread(unreadCount);
  }, [unreadCount]);

  useEffect(() => {
    if (!state.connected) return;
    void preloadConnectedApps(false, true).catch(() => {}); // a background read: a reconnect is nobody using a Cloud home
  }, [state.connected]);
  useUsageSnapshot();

  useEffect(() => preloadScreens(), []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, bot?.threadId, group?.threadId, state.activeView, state.pluginsOpen, state.settingsOpen]);

  useEffect(() => {
    if (state.activeView === "routines" && previousViewRef.current !== "routines") {
      calendarOriginRef.current = previousViewRef.current === "team-map" || previousViewRef.current === "web-panel" ? previousViewRef.current : "chat";
    }
    previousViewRef.current = state.activeView;
  }, [state.activeView]);

  useEffect(() => {
    if (
      localVmWorkspaceBotId &&
      (state.activeView !== "chat" || state.selectedId !== localVmWorkspaceBotId)
    ) {
      setLocalVmWorkspaceBotId(null);
    }
  }, [localVmWorkspaceBotId, state.activeView, state.selectedId]);


  const openComputerFromWorkspace = (botId: string) => {
    setLocalVmWorkspaceBotId(null);
    dispatch({ type: "select", id: botId });
  };

  const closeCalendar = useCallback(() => {
    if (calendarOriginRef.current === "team-map") {
      dispatch({ type: "showTeamMap" });
      return;
    }
    if (calendarOriginRef.current === "web-panel" && state.webPanelId) {
      dispatch({ type: "showWebPanel", id: state.webPanelId });
      return;
    }
    dispatch({ type: "select", id: state.selectedId });
  }, [dispatch, state.selectedId, state.webPanelId]);
  const openCalendarRoom = useCallback((id: string) => {
    dispatch({ type: "select", id });
  }, [dispatch]);

  const nativeViewOverlayOpen =
    drawerOpen ||
    paletteOpen ||
    state.settingsOpen ||
    state.appSettingsOpen ||
    state.pluginsOpen;

  useEffect(() => {
    return window.hezuo?.onOpenAppSettings?.(section => dispatch({ type: "toggleAppSettings", open: true,
      ...(section === "organization" && window.hezuo?.organization && !remoteClient ? { section } : {}) }));
  }, [dispatch]);

  useEffect(() => {
    return window.hezuo?.desktopViewer?.onState((viewer) => {
      if (viewer.open || !viewer.contextId) return;
      const botId = viewer.contextId;
      void fetch(`/api/bots/${botId}/computer/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release" }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((snap) => {
          if (snap) dispatch({ type: "computerControl", botId, held: snap.held === true, helpReason: snap.helpReason ?? null, help: parseComputerHelp(snap.help) });
        })
        .catch(() => {});
      void fetch(`/api/bots/${botId}/computer/viewer-close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {});
    });
  }, [dispatch]);

  const framed = windowFramed(capabilities);
  // Closing the bot list puts focus back where it belongs even when its own button is not drawn at this width (the list
  // is inline from 800px): the chat's composer, else the chat itself.
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    requestAnimationFrame(() => {
      const button = menuButtonRef.current;
      if (button && button.getClientRects().length > 0) {
        button.focus({ preventScroll: true });
        return;
      }
      const target = document.querySelector<HTMLElement>('[data-product-chat] textarea, [data-product-chat] [data-tour="composer"] textarea, [data-product-chat]')
        ?? document.querySelector<HTMLElement>("[data-tour=composer] textarea");
      target?.focus({ preventScroll: true });
    });
  }, []);
  const strips = <>
    <LiveConnectionStrip connected={state.connected} hydrated={state.hydrated === true} />
    {!product && <AppNotices quiet={paletteOpen || drawerOpen || Boolean(localVmWorkspaceBotId)} viewer={viewer} />}
  </>;
  return (
    <div className={cn("flex h-full flex-col", framed && "bg-frame")}>
      <WindowFrameBar />
      {!framed && strips}
      <div className="relative flex min-h-0 flex-1">
      {!calendarFocus && !productGate && <button
        type="button"
        ref={menuButtonRef}
        aria-label={t("sidebar.aria")}
        aria-expanded={drawerOpen}
        aria-controls="product-bot-list"
        onClick={productDrawer ? openProductDrawer : () => setDrawerOpen(true)}
        className={cn(
          "absolute left-3 top-3 z-30 text-ink-secondary hover:bg-raised hover:text-ink",
          // The product layout keeps the list behind this button as a drawer up to 800px; below the md breakpoint it is
          // the ordinary round phone button, and above it a quiet control of its own.
          productDrawer
            ? "hidden size-9 items-center justify-center rounded-full border border-hairline bg-card p-0 text-ink max-[799.98px]:flex"
            : "rounded-md p-1.5 max-md:flex max-md:size-9 max-md:items-center max-md:justify-center max-md:rounded-full max-md:border max-md:border-hairline max-md:bg-card max-md:p-0 max-md:text-ink md:hidden",
        )}
      >
        <Menu size={18} className={cn(!productDrawer && "max-md:hidden")} />
        <ChevronLeft size={20} aria-hidden="true" className={cn(!productDrawer ? "hidden max-md:block" : "hidden")} />
      </button>}
      {drawerOpen && !calendarFocus && (
        <div
          aria-hidden
          data-sidebar-drawer-scrim
          onMouseDown={(e) => e.target === e.currentTarget && closeDrawer()}
          className={cn(
            "absolute inset-0 bg-black/50",
            productDrawer ? "z-40 max-[799.98px]:block min-[800px]:hidden" : "z-30 md:hidden",
          )}
        />
      )}
      {/* A framed window shows the app, its sidebar and the chat or page, as one square pane under the top bar and beside
          the window's rail, running to the window's right and bottom edges. */}
      <div data-window-card={framed ? "" : undefined}
        className={framed ? "relative flex min-w-0 flex-1 flex-col overflow-hidden bg-app" : "contents"}>
      {framed && strips}
      <div className={framed ? "relative flex min-h-0 flex-1" : "contents"}>
      {!calendarFocus && !productGate && <Sidebar
        collapseToIcons={collapseSidebar}
        open={drawerOpen}
        onClose={closeDrawer}
      />}
      {productGate ? (
        <ProductAccountGate />
      ) : state.activeView === "team-map" ? (
        <TeamMapPage />
      ) : state.activeView === "web-panel" ? (
        <WebPanelPage />
      ) : state.activeView === "routines" ? (
        <TriggersPage onBack={closeCalendar} onOpenRoom={openCalendarRoom} />
      ) : !remoteClient && localVmWorkspaceBotId ? (
        <LocalVmWorkspace
          primaryBotId={localVmWorkspaceBotId}
          overlayOpen={nativeViewOverlayOpen}
          onClose={() => setLocalVmWorkspaceBotId(null)}
          onOpenComputer={openComputerFromWorkspace}
        />
      ) : product && !bot && !group ? (
        <main data-product-waiting={account.runtime} className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <WindowDragStrip />
          <div className="w-full max-w-md px-5"><ChatNotice notice={state.notice} /></div>
          {(account.runtime === "starting" || state.hydrated !== true) && <Loader2 size={20} className="animate-spin" />}
          <div className="text-[14px]">{t(account.runtime === "starting" || state.hydrated !== true ? "product.starting" : "product.pending")}</div>
        </main>
      ) : noEngines ? (
        <NoEngines />
      ) : chiefStep ? (
        <EmptyChatShell />
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main data-app-loading={loading.text} className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <WindowDragStrip />
          <div className="w-full max-w-md"><ChatNotice notice={state.notice} /></div>
          {loading.busy && <Loader2 size={20} className="animate-spin" />}
          <div className="text-[14px]">{t(loading.text)}</div>
          {loading.command && (
            <div className="text-[12px]">
            {t("app.loading.startServer")} <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
            </div>
          )}
        </main>
      )}
      {state.settingsOpen && bot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <Suspense fallback={null}>
            <BotSettingsDialog key={`settings:${bot.id}`} bot={bot} />
          </Suspense>
        </div>
      )}
      {roomPanelOpen && group && (
        <RoomPanel key={`room:${group.id}`} group={group} overlay={notificationFeed && state.notificationsOpen && !twoSidePanelsFit} />
      )}
      {inboxShown && <InboxPanel />}
      {notificationFeed && !calendarFocus && state.notificationsOpen && <NotificationsPanel />}
      {notificationFeed && !calendarFocus && <NotificationRail />}
      </div>
      </div>
      {state.appSettingsOpen && <SettingsModal />}
      {state.pendingNewBot && <SimpleNewBotDialog action={state.pendingNewBot} onClose={() => dispatch({ type: "closeNewBot" })} />}
      {state.pluginsOpen && <PluginsPanel />}
      {state.shortcutsOpen && (
        <KeyboardShortcutsModal
          open={state.shortcutsOpen}
          onClose={() => dispatch({ type: "toggleShortcuts", open: false })}
        />
      )}
      {/* After the modals: same z-50 tier, so DOM order keeps the palette on top. */}
      <CommandPalette onOpenChange={setPaletteOpen} />
      {/* Blink resolves -webkit-app-region in DOM order, so this no-drag twin after the headers cuts the drawer button back out. */}
      {!calendarFocus && <span
        aria-hidden
        data-drawer-button-no-drag
        style={captionChrome.noDragStyle}
        className="pointer-events-none absolute left-3 top-3 size-[30px] md:hidden"
      />}
      </div>
      {/* Last child on purpose: Blink resolves -webkit-app-region in DOM order, so no-drag buttons must follow every drag region. */}
      <WindowCaptionButtons
        visible={capabilities.windowChrome === "win-caption" && Boolean(window.hezuo?.windowControls)}
      />
    </div>
  );
}

/** Hezuo Cloud's own onboarding, welcomes and tours never stand in a managed account's way: the account gate and the
 * default bot are the whole first run there. Ordinary source and self-hosted builds are untouched. */
function ProductSetupGate({ children }: { children: ReactNode }) {
  const { state } = useStore();
  return isProductWorkspace(state.config?.productManaged) ? null : <>{children}</>;
}

function Application() {
  useEffect(() => {
    initAnalytics();
  }, []);
  const viewer = useWelcomeViewer();
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <ThreadRefsProvider>
          <Shell viewer={viewer} />
        </ThreadRefsProvider>
        <ProductSetupGate>
          <WelcomeGate viewer={viewer} />
          <HezuoWelcome viewer={viewer} />
          <GuidedTour />
          <FirstConversationTour quiet={spotlightsQuiet(viewer)} />
        </ProductSetupGate>
        <LiveCallHost />
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}

export default function App() {
  const ended = useSessionEnded();
  if (ended) return <PairPage initialCode={null} reason={SESSION_ENDED_REASON} />;
  return <WorkspaceBackupRecovery><Application /></WorkspaceBackupRecovery>;
}
