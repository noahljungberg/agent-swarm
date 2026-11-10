---
name: agent-swarm
description: Generic orchestration workflow for making the current Claude Code/Codex session the controller that hands tasks to persistent Codex/Claude worker agents, waits for their replies, and reviews and commits their work. Not project-specific.
---

# Agent Swarm

Use this skill when the user wants one agent to become an orchestrator/controller and have other agents do bounded work.

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

You are the orchestrator, the senior developer. Workers are **persistent
employees**: each has a name and a saved conversation. You hire one by giving it
its first task, and every later task to the same name continues that
conversation, so it remembers what it built and why. The cardinal sin of
orchestration is hiring a fresh agent for work an existing employee already has
context on.

A worker is not a running process. Between tasks nothing is alive; the engine's
saved session carries the context, so workers survive reboots.

## The whole tool

```bash
# Give a task. Hires `coder` if the name is new, otherwise continues its conversation
agent-swarm run coder --worktree -- 'Add auth tests for src/auth.ts. Run npm test.'
# A reviewer works inside the tree it reviews, so point it there
agent-swarm run reviewer --engine claude --cwd ~/.agent-swarm/worktrees/repo-coder -- 'Review the uncommitted diff against docs/auth.md. Do not edit anything.'

# Block until they finish. Prints every new reply and the files each worker left uncommitted
agent-swarm wait

# Follow up: same name, same conversation
agent-swarm run coder -- 'Address the review: <findings>'
agent-swarm wait coder

agent-swarm list            # every worker and what it is doing right now
agent-swarm log coder 60    # what coder did, step by step
agent-swarm stop coder      # cut its current turn and drop its queued tasks
agent-swarm rm coder        # stop it and forget it
```

- **`run` options apply when hiring** and stick for the worker's life:
  `--engine codex|claude` (default codex), `--model ID`, `--effort LEVEL`,
  `--cwd DIR` (default: here), `--worktree`.
- **Defaults are the model policy.** Codex workers run `gpt-6-astra` at `xhigh`,
  Claude workers run `claude-opus-5-5`. Pass `--model` only to escalate.
- **Long tasks go on stdin:** `agent-swarm run coder <<'EOF' ... EOF`.
- **A task for a busy worker queues** behind its current turn. You get one reply
  back per task.
- **To steer a worker mid-task,** `stop` it and `run` the correction. Its
  conversation is kept, so it knows what it was doing.
- **`wait` blocks.** Run it in the background if your harness supports that, so
  you are woken when it exits. With no names it covers every worker of this
  project that is busy or has a reply you have not seen. Exit code 0 = every
  turn finished ok, 1 = one failed, was stopped or died, 124 = `--timeout S` hit.
  On a timeout it prints only what is new, never an older reply.
- **Names belong to a project** (a git repo and its worktrees). Call
  `agent-swarm` from inside that project; the same name from another repo is
  refused. Pick names that say the job: `auth-coder`, `api-reviewer`.

`agent-swarm` needs to run outside any sandbox your own harness applies, since
it starts worker processes and writes `~/.agent-swarm`.

## Workers never commit

Workers leave their changes uncommitted, and you review and commit them. Codex's
sandbox cannot write `.git` at all, and the rule is the same for Claude workers
so you never have to guess. After each `wait`:

```bash
git -C <worker cwd> diff            # read what it actually did
git -C <worker cwd> add -A
git -C <worker cwd> commit -m '<message in the repo's convention>'
```

Commit after every accepted turn. Uncommitted work in a worktree survives a
reboot on disk, but a commit is what makes it safe.

## When to use

Use this for:

- Parallel implementation tasks
- Multi-repo or multi-module work
- Independent research/review tasks
- Long running code agents
- Reviewer/fixer loops
- Any task where fresh context per worker is better than stuffing everything into the controller context

Do not hire workers for:

- Simple read-only questions
- Tiny edits
- Tasks requiring secrets in the prompt
- Multiple tasks that will edit the same files concurrently
- Production/deploy actions unless the user explicitly asked and the repo runbook permits it

## Picking models

Rankings, higher = better. Cost reflects actual paid cost in practice, not list price. Intelligence is how hard a problem you can hand the model unsupervised. Taste covers UI/UX, code quality, API design, and copy.

| model (CLI id)     | engine | cost | intelligence | taste |
|--------------------|--------|------|--------------|-------|
| `gpt-6-astra`      | codex  | 9    | 8            | 5     |
| `claude-opus-5-5`  | claude | 4    | 7            | 8     |
| `claude-fable-5-1` | claude | 2    | 9            | 9     |

The two workhorses are the engine defaults. Fable is the escalation path:
`--engine claude --model claude-fable-5-1`.

These are defaults, not limits. You have standing permission to override them: if a cheaper model's output does not meet the bar, redo it with a smarter model without asking.
Judge output quality, not price tags. Escalating is cheaper than shipping mediocre work.
Cost is a tie-breaker only; when axes conflict for anything that ships: intelligence > taste > cost.
Bulk/mechanical work (clear-spec implementation, data analysis, migrations): codex.
Anything user-facing (UI, copy, API design) needs taste >= 7: claude, or Fable when Opus falls short.
Reviews of plans/implementations: claude (Fable for hard ones); optionally add a codex worker as an extra independent perspective.
Never use Haiku or Sonnet. Never use a previous generation (GPT-5.x, Opus 5, Fable 5): if the current model is unavailable, report the blocker instead of downgrading.

A worker's model is fixed when it is hired. To change it, `rm` the worker and
hire again.

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

First check who you already have: `agent-swarm list`. Reuse any worker whose
project and mission fit, and only roster what's missing.

Before hiring, tell the user who you plan to employ and why:

```text
Roster:
1. name: auth-coder
   engine: codex, own worktree
   mission: implement the API tests; will also handle review fixes later
   acceptance: tests pass

2. name: auth-reviewer
   engine: claude
   mission: review auth-coder's diff against the spec
   dependency: auth-coder finished
```

Once the user agrees, that roster IS the team for the rest of the
conversation. Five turns later, a new implementation task goes to `auth-coder`
with `run`, not to a new name. Hire a new worker only when the task is in a
different repo, you need parallelism the team can't give, or a worker's
conversation has grown so large it is degrading (then `rm` it, hire it again
under the same name, and say so).

Keep at most 4 workers busy at once unless the user overrides.

### 3. Use `--worktree` for code-changing workers

`--worktree` gives the worker its own git worktree at
`~/.agent-swarm/worktrees/<repo>-<name>` on a new branch `agent/<name>`, cut from
your current HEAD. Use it whenever more than one worker changes code, so they
never share a working tree. It only works when hiring: an existing worker
without a worktree refuses the flag. Uncommitted changes in your own checkout are not in
the worktree, and `run` says so when that applies; if the main tree is dirty, do
not hire from it unless the user approves.

After you merge the branch, clean up:

```bash
git worktree remove ~/.agent-swarm/worktrees/<repo>-<name>
git branch -d agent/<name>
```

`rm` forgets the worker but leaves its worktree and branch alone. Hire the same
name again with `--worktree` and it gets that worktree back, with a fresh
conversation. That is how you replace a worker whose conversation has degraded
without losing its work.

### 4. Write the task

Every worker already gets these standing rules with each turn, so do not repeat
them: work only in its directory, read AGENTS.md / CLAUDE.md first, never commit,
push, merge or deploy, stop and ask when blocked, and end each reply with what
changed, what was run to verify it, and open questions.

Your task adds what only you know:

```text
Mission: <bounded task>
Context: <files, docs, decisions it must read or respect>
Acceptance criteria:
- <clear checks>
Verification:
- <commands to run>
```

Keep tasks specific. A vague task creates chaos. No secrets in tasks.

### 5. Wait, then review before reporting success

```bash
agent-swarm wait
git -C <worker cwd> diff
```

Read the reply, then read the diff: the reply is the worker's claim, the diff is
the fact. Check that it really ran the verification it reports; if not, run it
yourself or send it back. If a worker asks a question and the answer is obvious,
answer with `run`. If the answer changes scope or risk, ask the user.

A turn that reports `failed` says why (quota, crash, sandbox). `died` means the
worker process itself was killed; `run` it again and it resumes. A worker blocked
by its sandbox or permissions has no bypass flag: do that step yourself or ask
the user.

### 6. Reviewer/fixer loop

For serious code changes:

1. The implementer does the task. You commit what you accept.
2. The reviewer reviews the diff against the original spec.
3. If changes are required, `run` them on the implementer. It still has its context.
4. Repeat until approved.
5. Only then report ready to the user.

## Final report format

Report back in this shape:

```text
Agent swarm result:
- Workers: <names, and who is still busy>
- Completed: <names>
- Failed/blocked: <names + reason>
- Branches/worktrees: <list>
- Verification: <commands + pass/fail>
- PRs/commits: <links or hashes>
- User action needed: <review/merge/answer/approve>
```

## Safety rules

- No secrets in tasks.
- No production changes unless explicitly requested.
- No auto-merge unless explicitly requested.
- No overlapping file edits across concurrent workers.
- At most 4 busy workers by default.
- Worktrees for code-changing workers. Never put worker files under `/tmp`: it is wiped on reboot.
- The orchestrator owns review, commits and integration; workers do bounded tasks.

## How workers run

- **Codex:** one `codex app-server` per turn, `workspace-write` sandbox, never
  asks for approval. It can edit its directory and run commands there; it cannot
  write `.git`, and it has network access only if the user's Codex config grants it.
- **Claude:** one `claude -p` per turn with `--permission-mode auto`.

## If `agent-swarm` is missing

It needs Node 22.18 or newer, plus `codex` and/or `claude` on PATH.

When installed as a plugin, a SessionStart hook symlinks the CLI
(`skills/agent-swarm/src/cli.ts`) to `~/.local/bin/agent-swarm`, so the bare
`agent-swarm` commands in this skill just work, provided `~/.local/bin` is on
your `PATH`. If the command is still not found:

```bash
# plugin install: re-run the bundled linker
bash "${CLAUDE_PLUGIN_ROOT}/hooks/install-path.sh"

# or, working from a clone of the repo:
./install.sh
```

Then check with `agent-swarm help`.
