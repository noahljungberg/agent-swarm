# agent-swarm

A tmux-based orchestration skill for Codex / Claude Code. The current AI session
becomes an orchestrator that spawns separate Codex/Claude/Hermes worker agents in
tmux, tracks them in a TSV registry, tails their logs, sends them input, and
reviews their output. No daemon, no database — just bash, tmux, and files under
`~/.agent-swarm/`.

This repo is both a Claude Code **plugin** and a single-plugin **marketplace**.

## Install

**Claude Code**

```
/plugin marketplace add noahljungberg/agent-swarm
/plugin install agent-swarm@agent-swarm
```

**Codex**

```
codex plugin marketplace add noahljungberg/agent-swarm
codex
```

A SessionStart hook symlinks the bundled CLI to `~/.local/bin/agent-swarm`, so
make sure `~/.local/bin` is on your `PATH`. Verify with `agent-swarm doctor`.

**Manual (no marketplace)**

```bash
git clone https://github.com/noahljungberg/agent-swarm ~/agent-swarm
~/agent-swarm/install.sh
```

## Use

```bash
agent-swarm spawn --name coder --engine codex --model gpt-5.5 --reasoning xhigh --cwd ~/repo -- 'Add auth tests. Commit. Do not push.'
agent-swarm list
agent-swarm log coder 120
agent-swarm send coder 'Use option B and continue.'
agent-swarm assign coder -- 'Address the review comments and re-run the tests.'
agent-swarm stop coder
agent-swarm rm coder
```

Workers are **persistent employees**: `stop` sends one home keeping its
conversation id, and `assign` calls it back with new work, resuming its prior
context (Claude `--resume`, Codex `exec resume`) instead of spawning a fresh
agent. Run `agent-swarm selftest` to sanity-check the install.

Engines: `codex` (default), `claude`, `hermes`, `shell`. Full orchestration
workflow and safety rules are in `skills/agent-swarm/SKILL.md`.

## Requirements

`tmux` (required); `codex` / `claude` / `hermes` as needed for those engines.

## Layout

```
.claude-plugin/   marketplace.json + plugin.json (Claude Code)
.codex-plugin/    plugin.json (Codex)
hooks/            SessionStart hook that puts the CLI on PATH
skills/agent-swarm/
  SKILL.md        orchestration workflow
  scripts/agent-swarm   the CLI
  agents/openai.yaml    Codex agent interface
```
