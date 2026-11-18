import { BOT_STATES, type BotState } from "@/components/bot-states";
import { botShowsUnread } from "./bot-unread";
import { lastNonReceipt } from "./receipts";
import type { HezuoColor } from "../../../packages/shared/wire";
import type { LocaleKey } from "@/locales";

export { HEZUO_COLOR_NAMES, type HezuoColor } from "../../../packages/shared/wire";

export type HezuoState = BotState;
export const HEZUO_STATES = BOT_STATES;

export const STATE_GROUPS = {
  Lifecycle: ["sleeping", "waking", "idle", "listening", "thinking", "searching", "working"],
  Reactions: [
    "excited",
    "surprised",
    "suspicious",
    "angry",
    "drowsy",
    "happy",
    "curious",
    "confused",
    "bored",
    "proud",
    "shy",
    "sad",
    "laughing",
    "scared",
    "playful",
    "celebrate",
  ],
  "Agent morphs": ["orbit", "radar", "progress"],
  "Product cycle": [
    "spawning",
    "humming",
    "loading",
    "dictating",
    "writing",
    "sending",
    "receiving",
    "uploading",
    "notifying",
    "alerting",
    "dragging",
    "bouncing",
    "powering-down",
  ],
} satisfies Record<string, HezuoState[]>;

export const HEZUO_COLORS = {
  green: "#009957",
  blue: "#377FE6",
  red: "#D94B52",
  orange: "#E78531",
  purple: "#8057C8",
  cyan: "#0EA5C6",
  pink: "#D84F8B",
  yellow: "#D8A729",
  teal: "#01A492",
  coral: "#E5634E",
  silver: "#A8ADB4",
  chrome: "#B3BAC4",
} satisfies Record<HezuoColor, string>;

export const HEZUO_COLOR_LABEL = {
  green: "mascotColor.green", blue: "mascotColor.blue", red: "mascotColor.red", orange: "mascotColor.orange",
  purple: "mascotColor.purple", cyan: "mascotColor.cyan", pink: "mascotColor.pink", yellow: "mascotColor.yellow",
  teal: "mascotColor.teal", coral: "mascotColor.coral", silver: "mascotColor.silver",
  chrome: "mascotColor.chrome",
} as const satisfies Record<HezuoColor, LocaleKey>;

export const CHROME_GRADIENT: [string, string, string] = ["#F1F4F7", "#AEB8C3", "#66717E"];
export const CHROME_EYES = "#1E2833";

/** Light, base and dark stops of a figure's body. */
export const HEZUO_GRADIENTS = {
  green: ["#c8f8da", "#3fd086", "#0e9160"],
  blue: ["#c3daff", "#5b95ff", "#2a5ce0"],
  red: ["#ffd3d0", "#ff7a72", "#d83a48"],
  orange: ["#ffe5bd", "#ffa246", "#e36f18"],
  purple: ["#e5daff", "#a383f7", "#6f45d8"],
  cyan: ["#b9fff3", "#3fdcf2", "#1290cc"],
  pink: ["#ffdaec", "#f67cba", "#cc3a88"],
  yellow: ["#fff1b8", "#ffcf40", "#e09a12"],
  teal: ["#bff7ea", "#35d0b8", "#0c9285"],
  coral: ["#ffdccf", "#ff8f6b", "#e0552f"],
  silver: ["#f3f5f8", "#b9c0ca", "#7d8792"],
  chrome: CHROME_GRADIENT,
} satisfies Record<HezuoColor, [string, string, string]>;

export function colorSwatch(color: HezuoColor): string {
  const [light, mid, edge] = HEZUO_GRADIENTS[color];
  if (color === "chrome") return `radial-gradient(circle at 34% 26%, #ffffff 0%, ${light} 20%, ${mid} 55%, ${edge} 100%)`;
  return `linear-gradient(210deg, ${light}, ${mid} 45%, ${edge})`;
}

export const HEZUO_MOTIONS = [
  "arrive",
  "switch",
  "customize",
  "alert",
  "thinking",
  "working",
  "launch",
  "success",
  "celebrate",
  "blink",
  "surprise",
  "failure",
] as const;

export type HezuoMotion = "none" | (typeof HEZUO_MOTIONS)[number];

interface LegacyStates {
  [state: string]: HezuoState;
}

const LEGACY_STATES: LegacyStates = {
  deadpan: "idle",
  friendly: "happy",
  focused: "working",
  thinking: "thinking",
  excited: "excited",
  sleepy: "drowsy",
  surprised: "surprised",
  skeptical: "suspicious",
  worried: "scared",
  mischievous: "playful",
};

const KNOWN_STATES = new Set<string>(HEZUO_STATES);

export function normalizeState(value: string | null | undefined): HezuoState | null {
  if (!value) return null;
  if (KNOWN_STATES.has(value)) return value as HezuoState;
  return LEGACY_STATES[value] ?? null;
}

export const PICKABLE_STATES: HezuoState[] = [
  "idle",
  "happy",
  "curious",
  "drowsy",
  "working",
  "thinking",
  "listening",
  "sleeping",
  "suspicious",
  "proud",
];

type MascotMessage = {
  kind: string;
  tool?: { ok?: boolean };
};

export type MascotBotProfile = {
  name: string;
  title?: string;
  description?: string;
  mascotExpression?: string | null;
  busy?: boolean;
  unread?: boolean;
  tasks?: Array<{ unread?: boolean; routineRunId?: string }> | null;
  messages?: MascotMessage[];
};

export function stateForBot(bot: MascotBotProfile): HezuoState {
  const pinned = normalizeState(bot.mascotExpression);
  if (pinned) return pinned;

  const last = lastNonReceipt(bot.messages);

  if (last?.kind === "activity" && last.tool?.ok === false) return "alerting";
  if (bot.busy) return "working";
  if (botShowsUnread(bot)) return "notifying";
  if (last?.kind === "options") return "curious";

  const profile = `${bot.name} ${bot.title ?? ""} ${bot.description ?? ""}`.toLowerCase();
  const matches = (words: RegExp) => words.test(profile);

  if (matches(/\b(code|coding|developer|development|engineer|engineering|build|debug|program|software)\b/)) {
    return "working";
  }
  if (matches(/\b(research|researcher|search|investigate|strategy|strategist|study|learn|knowledge)\b/)) {
    return "searching";
  }
  if (matches(/\b(marketing|growth|launch|campaign|social|sales|outreach|brand)\b/)) {
    return "excited";
  }
  if (matches(/\b(overnight|night|background|async|queue|batch|long-running)\b/)) {
    return "drowsy";
  }
  if (matches(/\b(monitor|monitoring|incident|alert|watch|status|uptime)\b/)) {
    return "radar";
  }
  if (matches(/\b(review|reviewer|audit|critic|critique|quality|qa|test|legal)\b/)) {
    return "suspicious";
  }
  if (matches(/\b(security|secure|compliance|risk|privacy|finance|financial)\b/)) {
    return "scared";
  }
  if (matches(/\b(design|designer|creative|brainstorm|art|illustration|music|story)\b/)) {
    return "playful";
  }
  if (matches(/\b(support|help|success|onboarding|coach|teacher|guide|welcome)\b/)) {
    return "happy";
  }

  return "idle";
}
