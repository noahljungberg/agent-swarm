---
name: agent-swarm
description: Generic orchestration workflow for making the current Claude Code/Codex session the controller, spawning separate Codex/Claude/Hermes worker agents in tmux, tracking their state, monitoring logs, sending follow-up input, and reviewing results. Not project-specific.
---

# Agent Swarm

Use this skill when the user wants one agent to become an orchestrator/controller and spawn other agents to do bounded work.

Trigger phrases:

- "act as orchestrator"
- "spawn agents"
- "spawn codex agents"
- "parallel agents"
- "agent swarm"
- "fan this out"
- "make workers do this"
- "track agents"
- "monitor the agents"

This is generic. Do not assume StohnTrade unless the user explicitly names that project.

## Core model

The current Claude Code or Codex session is the orchestrator — the senior
developer. Workers are **persistent employees** — junior developers in live
tmux sessions, hired once per conversation and reused for every follow-up
task, tracked by the `agent-swarm` CLI. The cardinal sin of orchestration is
spawning a fresh agent for work an existing employee already has context on.

State lives in:

```text
~/.agent-swarm/
  agents.tsv        # registry of spawned workers
  prompts/          # prompt files
  runs/             # per-agent runner scripts
  logs/             # persistent logs
```

Installed command:

```bash
agent-swarm
```

The CLI is intentionally small: tmux + prompt files + logs + a TSV registry. This gives us the good part of the old Hans/Heinrich/OpenClaw workflow — explicit process tracking and monitorability — without requiring a full SQLite daemon/cron system up front.

## When to use

Use this for:

- Parallel implementation tasks
- Multi-repo or multi-module work
- Independent research/review tasks
- Long running code agents that need monitoring
- Reviewer/fixer loops
- Any task where fresh context per worker is better than stuffing everything into the controller context

Do not spawn workers for:

- Simple read-only questions
- Tiny edits
- Tasks requiring secrets in the prompt
- Multiple tasks that will edit the same files concurrently
- Production/deploy actions unless the user explicitly asked and the repo runbook permits it

Picking the right models for workflows and subagents
Rankings, higher = better. Cost reflects actual paid cost in practice, not list price. Intelligence is how hard a problem you can hand the model unsupervised. Taste covers UI/UX, code quality, API design, and copy.

| model    | cost | intelligence | taste |
|----------|------|--------------|-------|
| gpt-5.5  | 9    | 8            | 5     |
| sonnet-5 | 5    | 5            | 7     |
| opus-4.8 | 4    | 7            | 8     |
| fable-5  | 2    | 9            | 9     |

These are defaults, not limits. You have standing permission to override them: if a cheaper model's output does not meet the bar, rerun or redo with a smarter model without asking.
Judge output quality, not price tags. Escalating is cheaper than shipping mediocre work.
Cost is a tie-breaker only; when axes conflict for anything that ships: intelligence > taste > cost.
Bulk/mechanical work (clear-spec implementation, data analysis, migrations): use gpt-5.5.
Anything user-facing (UI, copy, API design) needs taste >= 7.
Reviews of plans/implementations: use fable-5 or opus-4.8; optionally add gpt-5.5 as an extra independent perspective.
Never use Haiku or sonnet.

## First command

Always check the tool before using it:

```bash
agent-swarm doctor
```

## Basic commands

```bash
# Hire a persistent Codex employee (live TUI in tmux — the default for coders)
agent-swarm spawn --name coder --engine codex --mode interactive --cwd "$PWD" -- \
  'Add missing auth tests. Follow AGENTS.md. Commit when done. Do not push.'

# One-shot Claude worker in print mode (fire-and-forget tasks)
agent-swarm spawn --name security-review --engine claude --cwd "$PWD" -- \
  'Review this codebase for security issues. Write findings to SECURITY_REVIEW.md.'

# List all tracked workers
agent-swarm list

# Show one worker metadata
agent-swarm status coder

# Read a worker (live TUI pane for interactive workers, log tail for exec)
agent-swarm log coder 120

# Is an interactive employee mid-task? ("busy" rc=0 / "idle" rc=1)
agent-swarm busy coder

# Steer a live worker — queued behind the current turn if it is busy
agent-swarm send coder 'Use option B and continue.'

# Hard-steer: cut the current turn (Esc), then send the correction
agent-swarm interrupt coder
agent-swarm send coder 'Stop — wrong file. Edit src/auth.ts instead.'

# Give an employee its next task, keeping its prior context
agent-swarm assign coder -- 'Address the review comments and re-run the tests.'

# Block until workers are done (exec: exited; interactive: idle at composer)
agent-swarm wait coder security-review --timeout 1800

# Stop a worker (sends it home; keeps its registry row + conversation id)
agent-swarm stop coder

# Remove from registry (forgets it)
agent-swarm rm coder
```

## Persistent employees — the default operating model

A worker is an employee, not a one-shot job. Hire once per conversation, then
`assign` every follow-up to the same employee. It keeps the full context of
what it built and why, and its conversation prefix stays warm in the provider's
prompt cache — a fresh agent pays for re-reading the repo and re-deriving
context every time.

**Hire coders as `--mode interactive`.** The engine's TUI stays alive in tmux
between tasks: follow-ups are typed straight in (no relaunch), you can steer it
mid-task, and `wait` returns when it goes idle. Use plain exec mode only for
fire-and-forget one-shots you will never follow up on.

**Reuse rule — check before every spawn.** Run `agent-swarm list` first. If an
employee's cwd/mission overlaps the new task, `assign` it instead of spawning.
Spawn a new employee only when:

- the task is in a different repo/worktree than every existing employee, or
- you need parallelism an existing employee can't give, or
- the employee's conversation has grown so large it is degrading — then
  recycle (`rm` + `spawn`) and say so.

Lifecycle:

- `spawn` hires an employee and gives it a stable conversation id.
- `assign <name> -- '<task>'` gives it new work. If it's a live interactive
  session, the task is typed in; otherwise the employee is relaunched
  **resuming its prior conversation** (Claude `--resume`, Codex `resume` /
  `exec resume`) in the same cwd, so it remembers its earlier work — this
  survives reboots and killed tmux sessions.
- `stop` sends it home but keeps its row and conversation id.
- `rm` fires it and forgets the conversation.

Steering a live employee mid-task:

- `send <name> '<msg>'` — types into the TUI; if the employee is mid-turn the
  message queues and is handled next.
- `interrupt <name>` — sends Esc to cut the current turn, for when it is going
  down the wrong path; follow with `send` to redirect.

A long-lived employee's context grows per task. Keep one employee to one
cwd/branch, and recycle it (`rm` + `spawn`) when its conversation gets large or
its work is unrelated.

## Engines

### Codex worker, default

```bash
# persistent employee (default for implementation work)
agent-swarm spawn --engine codex --mode interactive --name <name> --cwd <dir> -- '<prompt>'

# fire-and-forget one-shot
agent-swarm spawn --engine codex --name <name> --cwd <dir> -- '<prompt>'
```

Commands inside tmux: interactive runs
`codex -s workspace-write -a never --no-alt-screen '<prompt>'` (the TUI stays
open between tasks; the runner pre-trusts the cwd so fresh worktrees don't
block on the trust dialog); exec runs `codex exec --full-auto '<prompt>'`.

Use Codex for implementation workers by default.
Codex requires a git repo.

Options:

```bash
--no-full-auto         # no auto approval
--yolo                 # dangerous; only if user explicitly asks
--model gpt-5.5        # pin the codex model (reused when the worker is resumed)
--reasoning xhigh      # reasoning effort: minimal|low|medium|high|xhigh
```

### Claude worker

```bash
agent-swarm spawn --engine claude --name <name> --cwd <dir> -- '<prompt>'
```

Default command inside tmux:

```bash
claude -p '<prompt>' --max-turns 30
```

Use Claude for reviews, planning, architecture, and analysis-heavy tasks.
Use `--mode interactive` only if a multi-turn TUI session is necessary.

### Hermes worker

```bash
agent-swarm spawn --engine hermes --name <name> --cwd <dir> -- '<prompt>'
```

Default command:

```bash
hermes chat -q '<prompt>'
```

Use Hermes workers when the worker needs Hermes-specific tools/skills/memory, not just coding.

### Shell worker

```bash
agent-swarm spawn --engine shell --name tests --cwd <dir> --cmd 'npm test' -- 'run tests'
```

Use this to track long shell commands alongside agent workers.

## Orchestration workflow

### 1. Decide if the task should be split

Split only if tasks are independent. Good splits:

- Different repos
- Different modules with minimal overlap
- One implementer + one reviewer
- Research task + implementation task after research completes

Bad splits:

- Two workers editing the same file
- One worker depends on uncommitted work from another
- Vague tasks like "fix everything"

### 2. Propose the roster, then hire

First check for employees you already have: `agent-swarm list`. Reuse any whose
cwd/mission fits (`assign`), and only roster what's missing.

Before hiring, tell the user who you plan to employ and why:

```text
Roster:
1. name: coder
   engine: codex (interactive — persistent employee)
   cwd: /path/to/worktree
   mission: implement the API tests; will also handle review fixes later
   acceptance: tests pass; local commit created

2. name: reviewer
   engine: claude (exec one-shot per review)
   mission: review coder's diff against the spec
   dependency: coder idle
```

Once the user agrees, that roster IS the team for the rest of the
conversation. Five turns later, a new implementation task goes to `coder` via
`assign` — not to a new spawn.

### 3. Use isolated worktrees for code changes

For code-changing workers, prefer one git worktree per worker.

**NEVER put a worktree (or any worker working files) under `/tmp`.** `/tmp` is
volatile — it is wiped on reboot/crash and on session teardown. A worker mid-build
with uncommitted edits there loses everything when the box restarts (this has
already cost a 36-minute run). Use a persistent location like
`/home/$USER/agent-worktrees/<task-slug>`. Worktree commits live in the main
repo's shared `.git`, so committed work survives even if the worktree dir is
later removed — but only if it was committed. Pair this with the commit-first
rule below.

```bash
ROOT=/path/to/repo
BASE=main
BRANCH=agent/<task-slug>
WORKTREE="$HOME/agent-worktrees/<task-slug>"   # persistent — never /tmp

cd "$ROOT"
git fetch --all --prune
git status --short
git worktree add -b "$BRANCH" "$WORKTREE" "$BASE"
```

If the main working tree is dirty, do not spawn a worker from it unless the user explicitly approves.

**Durability for slow builds.** A worker that sits on a multi-minute build with
uncommitted work loses it if the box restarts. Two ways to be safe, in order of
preference:
- **Persistent worktree (always do this):** under `$HOME/...`, the worker's
  uncommitted edits survive teardown on disk, so the orchestrator can commit
  them at review time even if the worker never did.
- **Commit-first (when the worker CAN commit):** have the worker commit each
  item before building, build as post-commit verification (amend on fix). BUT
  note a Codex sandbox often CANNOT commit inside a git worktree — the worktree's
  gitdir lives at `<mainrepo>/.git/worktrees/<name>`, outside the sandbox-writable
  cwd, so `git commit` fails EROFS. When that happens, don't fight it: tell the
  worker NOT to commit/stash/reset, and have the orchestrator commit frequently
  from its own non-sandboxed shell. The persistent location (not worker commits)
  is what actually guarantees durability.

### 4. Write self-contained worker prompts

Every worker prompt must include:

```text
You are a worker under an orchestrator.
Working directory: <absolute path>
Mission: <bounded task>
Scope limits:
- Work only in this directory/repo.
- Do not touch production.
- Do not merge or deploy.
- Commit locally when done, but do not push unless explicitly instructed.
Mandatory context:
- Read AGENTS.md / CLAUDE.md / repo docs first if present.
Acceptance criteria:
- <clear checks>
Verification:
- <commands to run>
Output expected:
- changed files
- commits
- verification results
- blockers/questions
```

Keep prompts specific. A bad worker prompt creates chaos.

### 5. Spawn workers

Use `agent-swarm spawn`, not raw tmux, unless the script is missing.

```bash
agent-swarm spawn --name <name> --engine codex --cwd <worktree> -- '<prompt>'
```

For many workers, spawn at most 4 concurrently unless the user overrides.

### 6. Monitor

```bash
agent-swarm list
agent-swarm status <name>
agent-swarm log <name> 120
```

If a worker appears stuck, inspect its log before killing it.
If it asks a question and the answer is obvious, send it:

```bash
agent-swarm send <name> '<answer>'
```

If the question changes scope or risk, ask the user.

### 7. Review outputs before reporting success

After a worker exits:

```bash
agent-swarm status <name>
agent-swarm log <name> 160
git -C <worktree> status --short
git -C <worktree> log --oneline -5
git -C <worktree> diff --stat <base>...HEAD
git -C <worktree> diff <base>...HEAD
```

Then verify the worker actually ran the promised checks.
If not, run them or spawn a fix worker.

### 8. Reviewer/fixer loop

For serious code changes, use this loop:

1. Implementer worker does the task and commits.
2. Reviewer worker reviews the diff against the original spec.
3. If changes required, steer the implementer if still alive; otherwise spawn a fix worker on the same branch/worktree.
4. Repeat until approved.
5. Only then report ready to the user.

This is the old workflow's best idea: separate implementation from review.

## Final report format

Report back in this shape:

```text
Agent swarm result:
- Workers spawned: <N>
- Running: <names>
- Completed: <names>
- Failed/blocked: <names + reason>
- Branches/worktrees: <list>
- Verification: <commands + pass/fail>
- PRs/commits: <links or hashes>
- User action needed: <review/merge/answer/approve>
```

## Safety rules

- No secrets in prompts.
- No production changes unless explicitly requested.
- No auto-merge unless explicitly requested.
- No overlapping file edits across concurrent workers.
- Keep worker count reasonable; default max 4.
- Prefer worktrees for code-changing workers.
- NEVER place worktrees or worker files under `/tmp` — it is wiped on crash/reboot/teardown and loses uncommitted work. Use `$HOME/agent-worktrees/...`.
- Tell workers to commit each item before any long build, so a teardown can't eat uncommitted work.
- The orchestrator owns review and integration; workers do bounded tasks.

## If `agent-swarm` is missing

When installed as a plugin, a SessionStart hook symlinks the bundled CLI
(`skills/agent-swarm/scripts/agent-swarm`) to `~/.local/bin/agent-swarm`, so the
bare `agent-swarm` commands in this skill just work — provided `~/.local/bin` is
on your `PATH`.

If the command is still not found:

```bash
# plugin install: re-run the bundled linker
bash "${CLAUDE_PLUGIN_ROOT}/hooks/install-path.sh"

# or, working from a clone of the repo:
./install.sh
```

Then check with `agent-swarm doctor`.
