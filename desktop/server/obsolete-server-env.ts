const REPLACEMENTS = {
  OMB_DATA_DIR: "HEZUO_DATA_DIR",
  OMB_LOOPBACK_TRUST: "HEZUO_LOOPBACK_TRUST",
  OGB_PORT: "HEZUO_PORT",
} as const;

export function rejectObsoleteServerEnv(env: NodeJS.ProcessEnv): void {
  const obsolete = Object.entries(REPLACEMENTS)
    .filter(([name]) => env[name] !== undefined)
    .map(([name, replacement]) => `Unset ${name}; use ${replacement} instead.`);
  if (obsolete.length > 0) {
    throw new Error(`Obsolete server environment variables: ${obsolete.join(" ")}`);
  }
}
