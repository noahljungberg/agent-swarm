#!/usr/bin/env bash
# Manual install (no plugin marketplace): symlink this repo into place as a
# Codex + Claude Code skill and put the CLI on PATH.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
SKILL="$REPO/skills/agent-swarm"
mkdir -p ~/.local/bin ~/.codex/skills ~/.claude/skills
chmod +x "$SKILL/scripts/agent-swarm"
ln -sfn "$SKILL/scripts/agent-swarm" ~/.local/bin/agent-swarm
ln -sfn "$SKILL" ~/.codex/skills/agent-swarm
ln -sfn "$SKILL" ~/.claude/skills/agent-swarm
echo "installed. ensure ~/.local/bin is on PATH, then run: agent-swarm doctor"
