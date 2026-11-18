// The HEZUO_* switches the harness gives the agents proxy, read into the profile agents-catalog.ts lists tools for.

/** Which tools a conversation is shown, the same on every one of its turns. Presentation only: the server still
 * authenticates and scopes every call. */
export interface CatalogProfile {
  skillAuthoring: boolean;
  sharedComputers: boolean;
  voiceNotes: boolean;
  /** A treg key or a Cloud plan's research credential is held and this bot's research switch is on: x_search is mounted.
   * Absent means off. */
  xResearch?: boolean;
  /** As xResearch, and research works for that credential (the person's treg key, or a plan whose relay has research
   * on): research_search, research_endpoint and research_call are mounted too. Absent means off. */
  research?: boolean;
  memoryEnabled?: boolean;
  /** The section's Chief of Staff; the server refuses Chief-only tools to every other bot. */
  chief: boolean;
  /** Written into start_thread's schema: the only bot_id it accepts. */
  botId: string;
  /** features.chiefEscalations: raise_escalation is mounted. */
  escalations?: boolean;
  /** A Team Cloud: message_person is mounted. */
  team?: boolean;
  /** The person's Hezuo with a Chief's powers: its notification tools are mounted. */
  hezuo?: boolean;
  /** A direct chat whose bot may pick where it works (Works on is not Off and no team computer is its own): select_computer
   * is mounted, and the harness refuses a pick on any turn but a person's own message. */
  computerSelection?: boolean;
  /** A room's thread: the widget and page tools, which rooms refuse, and the wait tools, since a room holds no wait,
   * are not mounted. */
  room?: boolean;
}

/** Everything is off unless the harness says "1". */
export function catalogProfileFromEnv(env: NodeJS.ProcessEnv): CatalogProfile {
  return {
    skillAuthoring: env.HEZUO_SKILL_AUTHORING_ENABLED === "1",
    sharedComputers: env.HEZUO_SHARED_COMPUTERS_ENABLED === "1",
    voiceNotes: env.HEZUO_VOICE_NOTES === "1",
    xResearch: env.HEZUO_X_RESEARCH === "1",
    research: env.HEZUO_RESEARCH === "1",
    memoryEnabled: env.HEZUO_MEMORY_ENABLED !== "0",
    chief: env.HEZUO_CHIEF_OF_STAFF === "1",
    botId: env.HEZUO_BOT_ID ?? "",
    escalations: env.HEZUO_ESCALATIONS === "1",
    team: env.HEZUO_TEAM_PEOPLE === "1",
    hezuo: env.HEZUO_HEZUO === "1",
    computerSelection: env.HEZUO_COMPUTER_SELECTION === "1",
    room: env.HEZUO_ROOM === "1",
  };
}
