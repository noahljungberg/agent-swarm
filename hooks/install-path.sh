#!/usr/bin/env bash
# Symlink the bundled CLI onto PATH so the skill's bare `agent-swarm` commands run.
# ponytail: idempotent symlink, no-op if PATH dir or source is unavailable.
set -euo pipefail
root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
src="$root/skills/agent-swarm/scripts/agent-swarm"
[ -f "$src" ] || exit 0
chmod +x "$src" 2>/dev/null || true
mkdir -p "$HOME/.local/bin"
ln -sfn "$src" "$HOME/.local/bin/agent-swarm"
exit 0
