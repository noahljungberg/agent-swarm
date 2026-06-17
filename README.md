# agent-swarm

A tiny tmux-based orchestration skill for Codex / Claude Code. The current AI
session becomes an orchestrator that spawns separate Codex/Claude/Hermes worker
agents in tmux, tracks them in a TSV registry, tails their logs, sends them
input, and reviews their output. No daemon, no database — just bash, tmux, and
files under `~/.agent-swarm/`.

## Install

```bash
git clone <this-repo> ~/agent-swarm
~/agent-swarm/install.sh
agent-swarm doctor
```

`install.sh` symlinks:

- `scripts/agent-swarm` → `~/.local/bin/agent-swarm` (CLI on PATH)
- this repo → `~/.codex/skills/agent-swarm` and `~/.claude/skills/agent-swarm`

One source of truth; the consumers are symlinks, so nothing drifts.

## Use

```bash
agent-swarm spawn --name api-tests --engine codex --cwd ~/repo -- 'Add auth tests. Commit. Do not push.'
agent-swarm list
agent-swarm log api-tests 120
agent-swarm send api-tests 'Use option B and continue.'
agent-swarm stop api-tests
agent-swarm rm api-tests
```

Engines: `codex` (default), `claude`, `hermes`, `shell`. Full workflow and
safety rules are in `SKILL.md`.

## Requirements

`tmux` (required); `codex` / `claude` / `hermes` as needed for those engines.
