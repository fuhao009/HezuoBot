/** Saved workspace identity colors use the same palette across skins. */
const CLOUD_COLORS = ["blue", "teal", "purple", "orange", "red", "yellow"] as const;
type WorkspaceColor = (typeof CLOUD_COLORS)[number];

export function cloudColor(value: unknown): WorkspaceColor | null {
  return CLOUD_COLORS.find((color) => color === value) ?? null;
}

/** The skin's tone for a saved colour; the fallback for none is the app's quiet control tone. */
export function cloudColorFill(value: unknown): string {
  const color = cloudColor(value);
  return color ? `var(--identity-${color})` : "var(--color-control)";
}
