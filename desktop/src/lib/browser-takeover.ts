import { answerSignIn } from "./sign-in";
import { browserStreamAccess, createPreviewStreamClient, type PreviewStreamClient } from "./browser-stream-client";
import { t } from "./i18n";

interface SignInTakeover { botId: string; threadId: string; messageId: string; place: "browser" }
interface Session { ref: SignInTakeover; surface: EmbeddedBrowserSurfaceState | null; client: PreviewStreamClient; ready: Promise<void>; focus(): Promise<void>; cancel(): Promise<void> }
const sessions = new Map<string, Session>();

/** Cancels only this request, never a newer sign-in for the same bot. */
export async function cancelBrowserTakeover(ref: SignInTakeover): Promise<void> {
  const session = sessions.get(ref.botId);
  if (session?.ref.threadId === ref.threadId && session.ref.messageId === ref.messageId) await session.cancel();
}

/** A chat click opens an authorized viewer; native surfaces never grant profile or input authority. */
export async function requestBrowserTakeover(ref: SignInTakeover, botName: string, onError?: (error: string) => void): Promise<void> {
  const bridge = window.hezuo?.browserSurface;
  if (!bridge) throw new Error(t("signIn.windowUnavailable"));
  const previous = sessions.get(ref.botId);
  if (previous) {
    if (previous.ref.threadId === ref.threadId && previous.ref.messageId === ref.messageId) { await previous.ready; await previous.focus(); return; }
    await previous.cancel();
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
    let viewerId = "", controlled = false, opening = false, finished = false;
    let openingSurface: Promise<EmbeddedBrowserSurfaceState> | null = null;
    let cancelled = false;
    let released: (() => void) | null = null;
    const timer = setTimeout(() => fail(new Error(t("signIn.windowUnavailable"))), 20_000);
    const renewal = setInterval(() => {
      if (!finished && controlled && session.surface?.visible) session.client.send({ type: "renewControl" });
    }, 60_000);
    let stopWatching = () => {};
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(renewal);
      stopWatching();
      session.client.stop();
      if (sessions.get(ref.botId) === session) sessions.delete(ref.botId);
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (session.surface) void bridge.closeTakeover(session.surface).catch(() => {});
      onError?.(error.message);
      reject(error);
    };
    const open = async () => {
      if (!viewerId || !controlled || opening || finished) return;
      opening = true;
      try {
        openingSurface = bridge.takeover({ botId: ref.botId, threadId: ref.threadId, viewerId, title: t("signIn.windowTitle", { name: botName }) });
        session.surface = await openingSurface;
        if (finished) { await bridge.closeTakeover(session.surface); return; }
        clearTimeout(timer);
        resolve();
      } catch (cause) { fail(cause instanceof Error ? cause : new Error(String(cause))); }
    };
    const session: Session = {
      ref, surface: null, ready: promise,
      cancel: async () => {
        cancelled = true;
        finished = true;
        session.client.send({ type: "releaseControl" });
        cleanup();
        resolve();
        const timeout = Promise.withResolvers<null>();
        const deadline = setTimeout(() => timeout.resolve(null), 12_000);
        try {
          const surface = session.surface ?? await Promise.race([openingSurface?.catch(() => null) ?? Promise.resolve(null), timeout.promise]);
          if (surface) await bridge.closeTakeover(surface);
        } finally { clearTimeout(deadline); }
      },
      focus: async () => {
        if (!session.surface || finished) return;
        openingSurface = bridge.takeover({ botId: ref.botId, threadId: ref.threadId, viewerId, title: t("signIn.windowTitle", { name: botName }) });
        const surface = await openingSurface;
        if (finished) await bridge.closeTakeover(surface);
      },
      client: createPreviewStreamClient({ access: browserStreamAccess(ref.botId, window.location, { threadId: ref.threadId }), maxWidth: 1100, maxHeight: 780, width: 1100, height: 780 }, {
        onFrame: () => {}, onViewport: () => {}, onUnauthorized: () => fail(new Error(t("signIn.windowUnavailable"))),
        onGone: () => fail(new Error(t("signIn.windowUnavailable"))),
        onConnectedChange: connected => {
          if (!connected && session.surface && !finished) fail(new Error(t("signIn.windowUnavailable")));
        },
        onControl: control => {
          controlled = control.canOperate && control.controller === "you";
          if (!controlled) released?.();
          if (session.surface && !controlled && !finished) { fail(new Error(t("signIn.windowUnavailable"))); return; }
          if (!finished && !opening && control.canOperate && control.controller !== "you" && control.controller !== "another-viewer") session.client.send({ type: "takeControl" });
          void open();
        },
        onMessage: message => { if (message.type === "surface" && typeof message.viewerId === "string") { viewerId = message.viewerId; void open(); } },
      }),
    };
    sessions.set(ref.botId, session);
    stopWatching = bridge.onState(state => {
      if (state.surfaceId !== session.surface?.surfaceId || state.revision !== session.surface.revision || finished) return;
      if (state.status === "error") { fail(new Error(t("signIn.windowUnavailable"))); return; }
      if (state.status !== "closed") return;
      const releaseTimeout = setTimeout(() => released?.(), 8_000);
      finished = true;
      void (async () => {
        try {
          const release = Promise.withResolvers<void>();
          released = release.resolve;
          if (!session.client.send({ type: "releaseControl" })) throw new Error(t("signIn.windowUnavailable"));
          await release.promise;
          if (controlled) throw new Error(t("signIn.windowUnavailable"));
          if (!cancelled) await answerSignIn(ref, "done");
        } catch (cause) { onError?.(cause instanceof Error ? cause.message : String(cause)); }
        finally { clearTimeout(releaseTimeout); cleanup(); }
      })();
    });
  await promise;
}
