# Live calls with the chat open — desktop

Historical status: Date: 2026-09-25 · Status: implemented on the desktop, iPhone and Android.
The native clients are retired from supported scope; this records the original
implementation attribution, not current release or verification evidence.

## Intent

Success looks like:

- On every client, a spoken request appears in the chat (labelled "via call"),
  followed by the bot's normal activity and answer, while the voice keeps talking.
- The rules that connect voice and bot (what becomes a bot message, what the voice
  is told, spoken yes/no for approvals) exist once, on the harness, and behave
  identically for all three clients.
- A forgotten call ends by itself after 5 minutes without speech.

## Decisions

## Architecture

### One owner per action

- **Clients** own media only: microphone capture, speaker playback, local mute,
  captions from their own data channel, and the UI. They never send context
  appends. At session creation the harness restricts the untrusted client data
  channel: `session.client.data_channel = { allowed_client_events: ["session.close"],
  allowed_server_events: [{ type: "session.started" }, { type: "session.input_transcript.delta" },
  { type: "session.output_transcript.delta" }, { type: "session.closed" }, { type: "error" },
  { type: "info" }] }` (selector objects, per the SDK's `DataChannelConfig`; this
  does not apply to the sideband).
- **The harness** owns everything else through a **sideband** WebSocket attached
  to the session (`wss://api.openai.com/v1/live/sessions/{session_id}/attach`,
  `Authorization: Bearer <live key>`; verified: Node 22 and Electron 43's Node 24
  built-in `WebSocket` send the header). It receives transcripts and delegation
  events and sends `session.{thinking,commentary,instructions}.append`.

### Harness: `LiveCallController` (new, `desktop/server/live-call-controller.ts`)

One active call per harness. Responsibilities, moved from today's renderer
`LiveCall.tsx` plus new ones:

1. **Delegation → bot turn.** On `session.delegation.created` (target `client`),
   wait ~700 ms for trailing transcript, take the words since the previous
   request (`LiveTranscript.takeRequest`, moved to `packages/shared/`), and start an
   ordinary turn on the call's thread through the same internal path as
   `POST /api/bots/:id/messages`, marking the message `via: "call"`. Empty
   request → `instructions.append` "ask the user to repeat".
2. **Bot → voice.** Follow the thread's messages: activity chips with
   `tool.spoken` → quiet `thinking.append` (≤ 1 per 4 s); the turn's final text
   answer → speakable text (`toUtterances`, `desktop/server/tts/speech-text.ts`) →
   `commentaryChunks` (≤ 1,400 chars × 3, "The full answer is in the chat.") →
   `commentary.append` with the delegation id. A turn that ends without text →
   commentary "the result, or what went wrong, is in the chat".
3. **Approvals and questions.** A pending approval card → `instructions.append`
   with the existing spoken prompt; the next complete utterance (via delegation
   or a 1.2 s quiet window on the input transcript) is judged by
   `spokenConsent(…, "live")` (moved to `packages/shared/`), strict yes/no only, then
   decided through the same function as `POST /api/bots/:id/respond`. A Live
   call keeps the microphone open while the voice speaks, so there "ok",
   "okay", "sure" and "fine" are hedges, never the answer ("okay, yes" still
   allows; "okay" alone asks again), and input heard while the voice itself
   spoke (when `session.output_transcript.delta` carries `start_ms`/`end_ms`)
   is left out of the answer on both paths. Take turns keeps its own rule (its
   microphone is closed while the bot talks). A card decided on the call records
   `answeredBy.via: "call"`, and its decision-log row `via: "call"` (the CSV
   export shows "(by voice)"). Skill approvals cannot be granted by voice.
   Option cards → the next request becomes the card's answer. A connect-an-app
   card or a credential card gets one spoken pointer to the chat; the voice is
   told never to ask for a credential aloud.
5. **Status notes.** While the bot works on the call's thread, every 30 s the
   voice gets a quiet `thinking.append`: how long the bot has worked, how many
   steps, and the last step's name (never its arguments). The instructions tell
   the voice to answer "is it still working / stuck?" from the latest note
   instead of guessing or delegating (a delegated status question is steered
   into the running turn). Found in testing: the voice said "I see it is
   stuck" during a 5-minute turn it knew nothing about. With `readTypedReplies`
   off, progress and status notes are sent only while the bot works on a spoken
   request.
6. **Idle hang-up.** No input speech, no bot work in progress, and no output
   speech for `idleMinutes` (default 5) → `session.close`, end reason `idle`.

Config (`config.live`): `key` (secret, desktop credential store, unchanged;
optional, see below), `voice`, `readTypedReplies` (boolean, default true),
`idleMinutes` (1–60, default 5).

### Who may call, and with which key

### Message label

### The call id and the call row

- **Call id.** Every user line a call delivers carries `callId`, the call's
  `LiveCallState.callId`, next to `via: "call"`: a request that starts a
  turn, one steered into a running turn, one that waits in the queue (the
  queue, its drain and crash recovery keep it, as they keep `via`), and a
  spoken answer to a question whose turn had already ended. No other line
  carries one. A turn's own messages point at their request through
  `requestMessageId`, as before.
- **Call row.** When a call that went live (its sideband attached) ends, the
  harness appends one message at the chat's active leaf:
  `{ role: "bot", kind: "call", text, call }`.
  `call` is a `LiveCallRecord`: `callId`, `botId`, `client`, `startedAt`,
  `endedAt`, `seconds` (whole seconds: OpenAI's usage seconds when it sent
  them, otherwise wall-clock time, as in the summary line), `endReason`, and
  an optional `title`. `text` is "Call with <bot> · m:ss" (h:mm:ss from an
  hour on), so a client that does not know the kind shows a plain line. A call
  that never went live leaves no row, and neither does a call whose chat was
  deleted.
- **Title.** With the gates of Regenerate title (generated thread titles on,
  `features.llmThreadTitles`; an engine with a one-shot; no hosted or
  organisation policy against it; the spend cap not reached) and its
  10-second cap, the bot's own engine names the call from its spoken requests
  alone, never from the bot's answers or the voice's words. The row is written
  first and the title arrives as a `message.patch` of it, scrubbed of secrets
  like other bot-authored text. When no title comes (a gate refuses, the
  one-shot fails, runs past the cap or answers nothing usable, the harness was
  shutting down, or nothing was asked on the call) the row keeps its text and
  clients show "Call with <bot>". Nothing new reaches OpenAI: the call is over,
  and the bot's own engine already saw those requests.
- **What a call's record lists.** The messages whose `requestMessageId` points
  at one of the call's spoken lines: the steps and the approval cards of the
  turns those requests started. A step is a tool the provider ran, a chip with
  a provider item id (`tool.itemId`). The harness's own chips inside a turn
  (the receipt of an automatic approval, a notice, a rejected action, a retry)
  have none, so they are never steps, and an auto-approved action is listed
  once. A line steered into a running turn starts no turn of its own, so its
  work is the work of the turn it was steered into: it counts for this call
  when that turn began with one of the call's lines (a typed line steered into
  it included), and not when it began with a typed line or another call's.
  Only what the server ties to a turn carries `requestMessageId`: provider
  permission cards do, but cards the server appends itself never do (skill
  proposals, team memory, "Send on your behalf?", and the receipt with Undo of
  a change a bot made to its own profile, model, routines or skills without a
  card), so a record never lists them, and question cards are left out. A turn
  still running at hang-up keeps adding steps after the row, and the record
  keeps listing them.
- **Never context.** The row is not conversation context for the bot
  (`isContextMessage` keeps text, digest, compaction and room-result
  messages, and the row is none of those), and not startup history for the
  next call (`liveHistoryFrom` keeps kind `"text"` only).
- **No speech.** The row holds ids, times, a length, the client and end-reason
  codes and an optional title made from requests the chat already holds. The
  voice's own words are still never stored.
- **Wire.** No new SSE frame, route or companion change: the row travels on
  `message` and `message.patch`, and `live.call` and `LiveCallState` are
  unchanged.

## Desktop

- **Media lives app-wide** (`desktop/src/lib/live-call-media.ts`, mounted once at the
  app root), so switching chats does not end the call.
- **Call bar** (in the call's chat, above the composer): bot, "Live with Ada ·
  m:ss", one caption line (the voice's words; the user's own words in grey
  while they speak), **gear**, **Mute**, **Hang up**. Errors and ends appear
  in the bar, with **Try again** only after a drop or a failed start (see
  **Client rules**). Narrow windows: icon-only buttons, caption on a second line.
- **Gear popover:** Voice · Read replies to typed messages (with what off
  means) · Hang up after N minutes of silence · OpenAI key (change / remove) ·
  the disclosure sentence and the cost.
- Escape no longer hangs up a Live call. Take turns is unchanged.
- A decided approval card reads "Allowed · by voice" / "Denied · by voice"
  when it was decided on the call.
- **Call record:** a finished call's `call` row draws as a compact centred
  row: a waveform glyph, the title or "Call with <bot>", the length, and one
  line per step (by name, never its arguments) and approval (with its outcome,
  and "by voice" when it was decided on the call) among the work the call's
  spoken requests started (see **The call id and the call row**). A step
  that never reports how it went (its turn was stopped or lost) shows the
  working dots only while the chat is working, and a neutral dash once it
  is not. The record reads what is loaded: while older messages remain on the
  server and the oldest one loaded is later than the call's start, it adds
  that some of the call may be in earlier messages. The "via call" lines
  stay inline. Like a work digest, the row is a receipt: the sidebar
  preview, Retry, the working line and the mascot's mood read past it.
- The window checks its own sign-in when its event stream drops during a
  call, and when OpenAI closes the call without an end frame: a `401` hangs
  up at once with the signed-out reason (a revoked browser sign-in has its
  stream cut and never gets the harness's end frame).

## Client rules (all three clients)

- **Hang-up:** after Hang up, the bar says "Hanging up…" until the computer
  confirms the end, and the end is quiet. Only the device whose Hang up asked
  for it does this: an end it did not ask for (another device hung up, the
  computer ended the call) keeps the call's title and clock while the call
  is `ending`, then shows the reason's words (a hang-up from another device
  reads "Call ended.").
- **Remote bar:** a call held by another device shows a bar with Hang up in
  that call's chat; it is hidden once that call is ending or ended.
- **Call button:** hidden while another device holds the line (any status but
  `ended`), in every bot's chat. On the desktop only a button that would
  start a Live call is hidden: in Take turns mode it starts a Take-turns
  call, which never uses the Live line, and a Take-turns call already
  running keeps its Hang up.
- **Going live and the clock:** "Connecting…" becomes live when the computer
  reports the call attached (any status but `connecting` and `ended`: `live`,
  `ending`, or one the client does not know) and the device's own data
  channel is open; the clock counts from that moment on the device's own
  clock. Accepted edge case: a call whose audio connects but whose data
  channel never opens stays on "Connecting…" (no clock, no captions) until
  Hang up or the idle hang-up; Hang up still works through the computer.
  There is no separate drop for it.
- **ICE gathering:** after 10 s the offer goes out with the candidates gathered
  so far; the call is not failed (a call whose audio never connects is dropped
  after 20 s).
- **Stale state:** a `GET /api/live/call` answer is applied only if no newer
  `live.call` frame arrived while it was in flight. A remote hang-up answered
  `404` re-reads the line.
- **Idle choices:** 1, 2, 3, 5, 10, 15, 30 or 60 minutes, one `PATCH` per choice.
- **Unknown status:** a status the client does not know counts as running (bar
  shown, Hang up allowed). **A `live.call` frame without a `call` key** is
  malformed and ignored, never read as "the line is free".
- **Signed out:** when the app's own session becomes unauthorized (unpaired,
  token refused, signed out), it hangs up its own Live call at once and shows
  the `signed-out` words.
- **Words:** "computer", not "Mac", in Live call text, except where the text
  is truly Mac-only.

## End reasons

`LiveCallState.endReason` codes, the words every client shows for them
(English; the desktop's `desktop/src/locales/en.json` is the source) and whether the
call counts as dropped, which is what offers **Try again**:

| Reason code | Words | Dropped |
|---|---|---|
| `hung-up` | "Call ended." (the device that hung up shows nothing) | no |
| `idle` | "Call ended after a long silence." | no |
| `expired` | "Call ended: it reached OpenAI's time limit." | no |
| `content` | "OpenAI ended the call under its content rules." | no |
| `deleted` | "Call ended: the chat was deleted." | no |
| `shutdown` | "Call ended: Hezuo restarted." | no |
| `signed-out` | "Call ended: you were signed out." | no |
| `remote-hangup` | "Call dropped." | yes |
| `connection-lost` | "Call dropped." | yes |
| `sideband-lost` | "Call dropped." | yes |
| `error` | "Call dropped." | yes |
| unknown or missing | "Call ended." | no |

## What a Live call sends to OpenAI

Every place where Live is turned on or set up says, in these words:

> A Live call sends your voice to OpenAI, along with the chat's recent
> messages, the bot's answers and the details of any approval it asks for. The
> OpenAI key stays on your computer.

The **Read replies to typed messages** setting says what off means, on every
client:

> When this is off, messages you type during a call and the bot's answers to
> them are not sent to OpenAI.

With it off, two things about a typed message still reach OpenAI: what the
bot asks of the person while it works on it (an approval, question or
proposal prompt, and a connect-an-app or credential pointer, whichever
request raised them), and an answer that also covers a spoken line (lines
drained from the queue together get one answer, and a batch holding a
spoken line is answered aloud). The docs page says so.

## Errors

## Security

- Client data channels cannot send appends (allowlist `session.close` only).
- Approvals are decided on the harness with the strict spoken rule; the card
  stays tappable in every client.
- Logs hold counters and codes only (existing summary line), never speech.

## Testing

- **Fake GPT-Live** (`desktop/server/testing/fake-openai-live.ts`): HTTP
  `POST /v1/live/sessions` + WebSocket `/v1/live/sessions/:id/attach` that plays
  scripted events and records commands; the harness reads its base URL from
  `HEZUO_OPENAI_LIVE_URL` (tests and fixtures only).

## Delivery

1. Harness controller + routes + desktop call bar (est. 2–3 days).

## Out of scope
