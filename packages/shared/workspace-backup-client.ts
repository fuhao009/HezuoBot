// Exact app-owned browser state that belongs in an encrypted full backup.
// Never include cookies, authentication tokens, connection caches or unknown keys.
export const WORKSPACE_BACKUP_CLIENT_KEYS = [
  "hezuo-drafts",
  "hezuo-draft-attachments",
  "hezuo-draft-send-ids",
  "hezuo-draft-channel-modes",
  "hezuo-skin",
  "hezuo-show-threads",
  "hezuo-show-run-card",
  "hezuo-send-key",
  "hezuo-color-user-bubbles",
  "hezuo-chat-width",
  "hezuo.sidebarDensity",
  "hezuo.sidebarToolsLayout",
  "hezuo.sidebarCollapsedSections.v1",
  "hezuo.sidebarSectionOrder.v1",
  "hezuo-analytics-opt-out",
  "hezuo.remote-voice.v1",
] as const;

export type WorkspaceBackupClientState = Partial<Record<(typeof WORKSPACE_BACKUP_CLIENT_KEYS)[number], string>>;
