#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# npm may inherit a different Node than the interactive shell on this machine.
for candidate in "${HEZUO_CORE_NODE:-}" "$HOME/.bun/install/global/node_modules/node-bin-darwin-arm64/bin/node" /opt/homebrew/opt/node@24/bin/node "$(command -v node || true)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  if "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24||(a===24&&b>=16)?0:1)' 2>/dev/null; then
    exec "$candidate" --env-file-if-exists=.env --disable-warning=ExperimentalWarning src/web.ts
  fi
done
printf '%s\n' 'Node >=24.16 is required; set HEZUO_CORE_NODE to its executable path.' >&2
exit 1
