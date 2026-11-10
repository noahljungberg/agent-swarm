# agent-swarm

An orchestration skill for Codex / Claude Code. The current AI session becomes an
orchestrator that hands tasks to persistent Codex and Claude worker agents, waits
for their replies, and reviews and commits their work.

A worker is a name plus a saved conversation. Nothing runs between tasks: each
task starts one headless engine process (`codex app-server` or `claude -p`) that
resumes the worker's session, runs one turn, and exits. No tmux, no daemon, no
database, just files under `~/.agent-swarm/`.

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

A SessionStart hook symlinks the CLI to `~/.local/bin/agent-swarm`, so make sure
`~/.local/bin` is on your `PATH`. Verify with `agent-swarm help`.

**Manual (no marketplace)**

```bash
git clone https://github.com/noahljungberg/agent-swarm ~/agent-swarm
~/agent-swarm/install.sh
```

## Use

The CLI is built for an agent to call, not a person.

```bash
agent-swarm run coder --worktree -- 'Add auth tests. Run npm test.'
agent-swarm run reviewer --engine claude -- 'Review the diff against docs/auth.md.'
agent-swarm wait                       # blocks, then prints each reply + uncommitted files
agent-swarm run coder -- 'Address the review comments.'   # same name, same conversation
agent-swarm list
agent-swarm log coder
agent-swarm stop coder
agent-swarm rm coder
```

- `run` hires the worker if the name is new, otherwise continues its conversation.
  A name belongs to the git repo it was hired in.
  A task for a busy worker queues behind its current turn.
- Codex workers default to `gpt-6-astra` at `xhigh`, Claude workers to
  `claude-opus-5-5`. The defaults live in `src/engines/index.ts`.
- `--worktree` gives a worker its own git worktree and branch `agent/<name>`.
- Workers never commit. Codex's sandbox cannot write `.git`, so the orchestrator
  reviews the diff and commits.

The full orchestration workflow and safety rules are in
`skills/agent-swarm/SKILL.md`.

## Requirements

Node 22.18+ (runs TypeScript directly, no build step and no runtime
dependencies), plus `codex` and/or `claude`.

## Layout

```
.claude-plugin/   marketplace.json + plugin.json (Claude Code)
.codex-plugin/    plugin.json (Codex)
hooks/            SessionStart hook that puts the CLI on PATH
skills/agent-swarm/
  SKILL.md            orchestration workflow
  src/cli.ts          the commands: run, wait, list, log, stop, rm
  src/worker.ts       the detached runner: drains one worker's queue, a turn at a time
  src/store.ts        a worker on disk: config, queue, turns, log, runner lock
  src/git.ts          git helper
  src/engines/        one turn on an engine
    types.ts          the engine contract
    claude.ts         claude -p, stream-json
    codex.ts          codex app-server, JSON-RPC
    index.ts          engine registry + default models
  test/cli.test.ts    the tool end to end, against fake claude/codex in test/stubs/
  agents/openai.yaml  Codex agent interface
```

## Develop

```bash
cd skills/agent-swarm
npm install     # typescript, for typechecking only
npm run check   # typecheck + tests
```
