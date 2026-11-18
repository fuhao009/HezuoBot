# Chat Widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Architecture:** One canonical JSON tree, normalised once on the server by `packages/shared/widget.ts`, stored on a new `widget` message kind with a text fallback. One recursive renderer per platform. A press is posted on the existing send-message route as `widgetAction`, becomes an ordinary user message that replies to the widget, and settles the widget with a `message.patch`.

**Spec:** `docs/superpowers/specs/2026-10-13-chat-widgets-design.md` (this repo). Design canvas: https://claude.ai/artifact/3jp8ZJ62qQCx8BXejVp8gv

## Global Constraints

- Ratchets (`scripts/testing/file-size-ratchet.test.ts`, `index-route-ratchet.test.ts`): `desktop/server/index.ts`, `desktop/src/state/store.tsx`, `desktop/server/store.ts`, `desktop/server/config.ts`, `ChatView.tsx`, `GroupView.tsx`, `scripts/mcp-server.ts`, `desktop/server/drivers/agents-call.ts` may not gain a line; `desktop/server/index.ts` may not gain a path guard; no new file over 1,000 lines. Move code out to make room and lower the pinned number.
- Server code runs on type stripping: type-only imports must be `import type`, no enums, no parameter properties.
- Tests are colocated `*.test.ts` (never `.tsx`); React tests start with `// @vitest-environment happy-dom` and use `createElement`.
- Colours come from tokens only: no hex literals in widget renderers on any platform.
- Renderers read canonical trees only and must never crash on one: an unknown node type draws its children or nothing.

## Review Focus

1. A model sends sloppy JSON (a string, extra props, a non-root at the top, ChatKit spacing units): it must normalise or fail with a sentence naming the path, never post a broken card. Pinned in Task 1.
2. A press arrives twice (double tap, client retry with the same `sendId`): one user message, one settle. Pinned in Task 2.
3. A press arrives for a settled widget, a wrong thread or another bot's message: refused with 409 or 404, nothing sent. Pinned in Task 2.
4. A secret pasted into a widget string, and a password field: redacted before storage; rejected at parse. Pinned in Tasks 1 and 2.

---

### Task 1: Shared schema and wire kind

**Files:**
- Create: `packages/shared/widget.ts`, `packages/shared/widget-samples.ts`, `packages/shared/widget.test.ts`
- Modify: `packages/shared/wire.ts` (kind union, `widget?: WidgetPayload`), `desktop/src/lib/taskTimeline.ts` (kind union)

**Interfaces (produces):**
```ts
export const WIDGET_LIMITS: {...}; export const WIDGET_ICON_NAMES: readonly string[];
export interface WidgetAction { type: string; payload?: JsonValue }
export interface WidgetNode { type: string; id: string; children?: WidgetNode[]; [prop: string]: unknown }
export type WidgetRoot = WidgetNode;            // type "Card" | "ListView"
export interface WidgetSettled { ref: string; label: string; tone: "confirm" | "cancel" | "submit"; at: number; sendId?: string }
export interface WidgetPayload { v: 1; root: WidgetRoot; settled?: WidgetSettled }
export type WidgetValues = Record<string, string | boolean>;
export function parseWidgetInput(value: unknown): { ok: true; value: WidgetRoot } | { ok: false; error: string };
export function widgetToText(root: WidgetRoot): string;
export function widgetFields(scope: WidgetNode, root: WidgetRoot): WidgetField[];   // {name, type, label, node}
export function widgetInitialValues(scope: WidgetNode): WidgetValues;
export function widgetScope(root: WidgetRoot, ref: string): WidgetNode;             // nearest Form, else root
export function widgetActions(root: WidgetRoot): WidgetActionEntry[];              // {ref, label, action, tone?, client?}
export function widgetActionByLabel(root: WidgetRoot, label: string): WidgetActionEntry | undefined;
export function resolveWidgetAction(payload: WidgetPayload, ref: string, values: unknown):
  | { ok: true; ref: string; label: string; action: WidgetAction; values: WidgetValues; text: string; tone?: "confirm" | "cancel" | "submit" }
  | { ok: false; status: 400 | 404 | 409; error: string };
```
`WIDGET_SAMPLES` (in `widget-samples.ts`) is a record of named model-shaped inputs covering every node type; tests, fixtures and the verification recipe all use it.

- [ ] Write `packages/shared/widget.test.ts` first: one case per node type normalising, each limit refusing with its path, password refusal, non-root wrapping, JSON-string input, spacing-unit conversion, duplicate action labels made unique by their row title, `widgetToText` snapshots for the list, form, table and chart samples, and `resolveWidgetAction` for scope, required, option, date, settled (409), unknown ref (404) and `cancel` skipping validation.
- [ ] Run `pnpm exec vitest run packages/shared/widget.test.ts`; it fails on the missing module.
- [ ] Implement `packages/shared/widget.ts` and `packages/shared/widget-samples.ts`; add the kind and field to `packages/shared/wire.ts` and the kind to `desktop/src/lib/taskTimeline.ts`.
- [ ] Run the test, `pnpm typecheck`, `pnpm lint`. Commit.

### Task 2: Server

**Files:**
- Create: `desktop/server/chat-widgets.ts`, `desktop/server/chat-widgets.test.ts`, `desktop/server/drivers/agents-widget-tools.ts`, `desktop/server/drivers/agents-call-cards.ts`
- Modify: `desktop/server/index.ts` (swap `createOptionsCard` for `createAgentCard`, same line count), `desktop/server/drivers/agents-catalog.ts` (spread the two definitions; read-only annotation list untouched), `desktop/server/drivers/agents-call.ts` (the `create_options_card` branch moves into `agents-call-cards.ts`, which also handles the two widget tools; lower its ratchet number), `desktop/server/routes/bot-messages.ts` (`widgetAction`), `desktop/server/replies.ts` (widget branch), `desktop/server/delta-context.ts` (`isContextMessage`), `desktop/server/routes/threads.ts` (markdown export line), `desktop/server/team-backup.ts` (`messageText`), `scripts/mcp-server.ts` (projection keeps `widget`, in place), `desktop/server/drivers/agents-catalog-wire.test.ts` goldens and budget baselines, `scripts/testing/file-size-ratchet.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces: `createAgentCard({store, bot, threadId, input}): {ok: true; messageId: string} | {ok: false; status: 400|403|404|409; error: string}`; the internal body shape `{tool: "show_widget", widget, fallback_text?}` and `{tool: "update_widget", widget_id, widget}`; the public body field `widgetAction: {messageId: string, ref: string, values?: Record<string, string|boolean>}` on `POST /api/bots/:id/messages` with `text` omitted.

- [ ] Tests first (`desktop/server/chat-widgets.test.ts`, additions to `desktop/server/replies.test.ts` or a new one, and a bot-messages route test following the existing route tests): create posts `kind: "widget"` with fallback text and no `from`; a room thread is 409; strings are redacted; `update_widget` replaces a live tree and refuses a settled one, another bot's message and another thread's; a press sends one user message replying to the widget with the label text; `confirm` settles, a plain button does not; the same `sendId` twice sends once and patches once; a settled widget is 409; `promptWithReply` names the action and payload; `isContextMessage` admits a widget row.
- [ ] Implement. `createAgentCard` delegates a body without `tool` to `createOptionsCard` unchanged.
- [ ] Regenerate goldens with `UPDATE_AGENTS_CATALOG_GOLDENS=1 pnpm exec vitest run desktop/server/drivers/agents-catalog-wire.test.ts`, then edit `BUDGET_BASELINE` by hand to the printed sizes.
- [ ] Run the touched tests, both ratchet tests, `pnpm typecheck`, `pnpm lint`. Commit.

### Task 3: Desktop renderer

**Files:**
- Create: `desktop/src/components/widget/WidgetMessage.tsx`, `WidgetNodes.tsx`, `WidgetControls.tsx`, `WidgetChart.tsx`, `widget-icons.ts`, `widget-send.ts`, tests beside them (`*.test.ts`), `desktop/src/components/OptionsCardRow.tsx`
- Modify: `desktop/src/components/ChatView.tsx` (the `options` case moves into `OptionsCardRow`; add `case "widget"`; lower its ratchet number), `desktop/src/state/store.tsx` (`Message` gains `kind` and `widget` from `WireMessage`, in place), `desktop/src/lib/export-transcript.ts`, `desktop/src/locales/en.json`

**Interfaces:**
- Consumes: Task 1 types and helpers; the `widgetAction` body from Task 2.
- Produces: `<WidgetMessage botId threadId message />`, default-exported pieces not used elsewhere.

- [ ] Tests first: every sample in `WIDGET_SAMPLES` renders to markup without throwing; a list with `limit` shows "Show all"; a settled payload renders the tick line and no buttons; pressing `confirm` posts `{threadId, sendId, widgetAction}` with the form's current values; a required empty field blocks the post and marks the field; `open_url` opens the link and posts nothing; a server refusal shows its sentence in the card.
- [ ] Implement to the canvas: surface, header, rows, dot status, actions under the card, settled line with Details, `size` widths, SVG chart from tokens.
- [ ] Run tests, `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check`, `pnpm check:contrast`, both ratchets. Commit.

### Task 6: End-to-end verification and review

- [ ] Add `docs/verification/widgets.md` (checked by `scripts/testing/verification-docs.test.ts`) and run it against an isolated fixture: a fake-engine `show_widget` call, `messages` shows the widget row, the UI snapshot shows the card, a click settles it and starts a turn. Keep the JSON and screenshots.
- [ ] Compare desktop screenshots in Meadow and Midnight against the canvas; fix differences.
- [ ] Whole-branch review of both repos; fix findings; run every check in Global Constraints once more.
