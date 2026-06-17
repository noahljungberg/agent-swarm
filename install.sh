#!/usr/bin/env bash
# Symlink this repo into place as a Codex + Claude Code skill and a CLI on PATH.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
mkdir -p ~/.local/bin ~/.codex/skills ~/.claude/skills
chmod +x "$REPO/scripts/agent-swarm"
ln -sfn "$REPO/scripts/agent-swarm" ~/.local/bin/agent-swarm
ln -sfn "$REPO" ~/.codex/skills/agent-swarm
ln -sfn "$REPO" ~/.claude/skills/agent-swarm
echo "installed. ensure ~/.local/bin is on PATH, then run: agent-swarm doctor"
