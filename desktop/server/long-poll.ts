/** Long polls are held open on purpose, so the idle-timeout check exempts them. */
export function isLongPollPath(path: string): boolean {
  return path.startsWith("/api/shared-computers/");
}
