#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ENGINES } from './engines/index.ts';
import { git } from './git.ts';
import * as store from './store.ts';
import { work } from './worker.ts';

const HELP = `agent-swarm: give tasks to persistent worker agents and collect their replies

  agent-swarm run NAME [options] -- TASK   give NAME a task. Hires NAME if new, else continues its conversation
  agent-swarm wait [NAME...] [--timeout S] block until they finish, then print every new reply and the uncommitted files
  agent-swarm list                         every worker and what it is doing
  agent-swarm log NAME [LINES]             what NAME did, step by step
  agent-swarm stop NAME                    cut NAME's current turn and drop its queued tasks
  agent-swarm rm NAME                      stop NAME and forget it

run options, used when hiring (a worker keeps them for life):
  --engine ENGINE   ${Object.entries(ENGINES).map(([name, e]) => `${name} = ${e.model}${e.effort ? ` ${e.effort}` : ''}`).join(', ')}. Default codex
  --model ID        override the engine's model
  --effort LEVEL    override the reasoning effort
  --cwd DIR         where it works. Default: here
  --worktree        give it its own git worktree on a new branch agent/NAME, cut from HEAD

A long TASK can come on stdin instead:  agent-swarm run NAME <<'EOF' ... EOF
A task sent to a busy worker queues behind its current turn.
Workers never commit. Review the uncommitted files that wait lists, then commit them yourself.
wait exits 0 if every worker finished ok, 1 if any failed, 124 on timeout.`;

function fail(message: string): never {
  console.error(`agent-swarm: ${message}`);
  process.exit(2);
}

const busy = (name: string) => store.runnerPid(name) !== null || store.queueLength(name) > 0;

// a turn with no end and no runner -> the runner died under it
const turnState = (turn: store.Turn) => (!turn.ended ? 'died' : turn.ok ? 'done' : turn.error === 'stopped' ? 'stopped' : 'failed');

function status(name: string): string {
  if (busy(name)) return 'busy';
  const turn = store.loadTurn(name);
  return turn ? turnState(turn) : 'idle';
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;  // also keeps a name from walking out of the workers dir

function existing(name: string | undefined): store.Worker {
  return (name && NAME.test(name) && store.loadWorker(name)) || fail(`no worker named ${name ?? '(missing name)'}. agent-swarm list shows them`);
}

function startRunner(name: string): void {
  if (store.runnerPid(name) !== null) return;
  const err = openSync(store.path(name, 'runner.err'), 'a');
  // detached -> its own process group, so it outlives this command and `stop` can kill the group
  spawn(process.execPath, [process.argv[1]!, '_work', name], { detached: true, stdio: ['ignore', 'ignore', err] }).unref();
}

// --- run ---

// The repo a dir belongs to. Worktrees of one repo share it
function project(dir: string): string {
  try { return realpathSync(git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')); } catch { return dir; }
}

function addWorktree(repo: string, name: string): string {
  const top = git(repo, 'rev-parse', '--show-toplevel');
  const dir = join(store.HOME, 'worktrees', `${basename(top)}-${name}`);  // under the home dir, never /tmp
  git(top, 'worktree', 'add', '-b', `agent/${name}`, dir);
  console.log(`${name}: worktree ${dir} on new branch agent/${name}, cut from ${git(top, 'rev-parse', '--short', 'HEAD')}`);
  if (git(top, 'status', '--short')) console.log(`${name}: note, uncommitted changes in ${top} are not in the worktree`);
  return realpathSync(dir);
}

function run(args: string[]): void {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { engine: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, cwd: { type: 'string' }, worktree: { type: 'boolean' } },
  });
  const [name, ...words] = positionals;
  if (!name || !NAME.test(name)) fail('run needs a worker name: lowercase letters, digits and dashes');
  const task = (words.join(' ') || (process.stdin.isTTY ? '' : readFileSync(0, 'utf8'))).trim();
  if (!task) fail('no task. Pass it after -- or on stdin');
  const here = realpathSync(values.cwd ?? process.cwd());

  let worker = store.loadWorker(name);
  if (worker) {
    for (const key of ['engine', 'model', 'effort'] as const) {
      if (values[key] && values[key] !== worker[key]) fail(`${name} already exists with ${key} ${worker[key] ?? '(engine default)'}. agent-swarm rm ${name} to change it`);
    }
    // the same name in another project would silently get this task
    if (project(here) !== project(worker.cwd)) fail(`${name} belongs to another project (${worker.cwd}). Pick another name, or pass --cwd ${worker.cwd} to use that worker`);
  } else {
    const engine = values.engine ?? 'codex';
    const defaults = ENGINES[engine] ?? fail(`unknown engine ${engine}. Use ${Object.keys(ENGINES).join(' or ')}`);
    const cwd = values.worktree ? addWorktree(here, name) : here;
    worker = { name, engine, cwd, model: values.model ?? defaults.model, effort: values.effort ?? defaults.effort, branch: values.worktree ? `agent/${name}` : undefined, session: null };
    store.saveWorker(worker);
  }
  const queuedBehind = busy(name);
  store.enqueue(name, task);
  startRunner(name);
  console.log(queuedBehind ? `${name}: queued behind its current turn` : `${name}: working (${worker.engine} ${worker.model}, ${worker.cwd})`);
}

// --- wait ---

function block(name: string, state: string, turn: store.Turn | null, body: string): string {
  if (!turn) return `== ${name}: ${state}\n${body}\n`;
  const s = Math.round(((turn.ended ? Date.parse(turn.ended) : Date.now()) - Date.parse(turn.started)) / 1000);
  return `== ${name}: ${state}, turn ${turn.n}, ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`}\n${body}\n`;
}

// The worker's tree as it is right now, so a commit made since the turn is not listed
function uncommitted(cwd: string): string {
  let files: string[] = [];
  try { files = git(cwd, 'status', '--short').split('\n').filter(Boolean); } catch { /* cwd is not a repo */ }
  if (!files.length) return '';
  const more = files.length > 30 ? `\n... and ${files.length - 30} more` : '';
  return `\n\nuncommitted in ${cwd}:\n${files.slice(0, 30).join('\n')}${more}`;
}

// Every turn that finished since the last wait (or the last one again), then where the worker is now.
// One reply back per task given, even when two were queued
function report(name: string): { blocks: string[]; states: string[] } {
  const state = status(name);
  const finished = store.loadTurns(name).filter((t) => t.ended);
  const unseen = finished.filter((t) => t.n > store.reported(name));
  const shown = unseen.length ? unseen : finished.slice(-1);
  const states: string[] = shown.map(turnState);
  const blocks = shown.map((turn, i) => {
    const last = i === shown.length - 1 && state !== 'busy';  // the tree is still changing while busy
    return block(name, turnState(turn), turn, `${turn.ok ? turn.reply : turn.error}${last ? uncommitted(store.loadWorker(name)!.cwd) : ''}`);
  });
  const current = store.loadTurn(name);
  const running = current && !current.ended ? current : null;
  if (state === 'busy') blocks.push(block(name, state, running, store.readLog(name, 1)));
  if (state === 'died') blocks.push(block(name, state, running, `the worker process died mid-turn, see ${store.path(name, 'runner.err')}. Run it again to continue`));
  if (state === 'busy' || state === 'died') states.push(state);
  if (finished.length) store.markReported(name, finished.at(-1)!.n);
  return { blocks, states };
}

async function wait(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { timeout: { type: 'string' } } });
  const names = positionals.length ? positionals : store.listWorkers().filter(busy);
  if (!names.length) { console.log('no busy workers'); return; }
  for (const name of names) {
    existing(name);
    if (store.queueLength(name)) startRunner(name);  // tasks left over from a crash or reboot
  }
  const seconds = values.timeout === undefined ? Infinity : Number(values.timeout);
  if (!(seconds > 0)) fail('--timeout takes a number of seconds');
  const deadline = Date.now() + seconds * 1000;
  while (names.some(busy) && Date.now() < deadline) await sleep(1000);
  const reports = names.map(report);
  const states = reports.flatMap((r) => r.states);
  console.log(reports.flatMap((r) => r.blocks).join('\n'));
  process.exitCode = states.includes('busy') ? 124 : states.every((s) => s === 'done') ? 0 : 1;
}

// --- the rest ---

function list(): void {
  const names = store.listWorkers().filter((name) => store.loadWorker(name));
  if (!names.length) { console.log('no workers'); return; }
  for (const name of names) {
    const worker = store.loadWorker(name)!;
    const turn = store.loadTurn(name);
    const state = status(name);
    console.log(`${name.padEnd(18)} ${state.padEnd(8)} ${`${worker.engine} ${worker.model}`.padEnd(24)} ${(turn ? `turn ${turn.n}` : '').padEnd(8)} ${worker.cwd}`);
    if (state === 'busy') console.log(`  ${store.readLog(name, 1)}`);
  }
}

function log(args: string[]): void {
  console.log(store.readLog(existing(args[0]).name, Number(args[1] ?? 40)));
}

async function halt(name: string): Promise<boolean> {
  store.clearQueue(name);
  const pid = store.runnerPid(name);
  if (pid === null) return false;
  process.kill(-pid, 'SIGTERM');  // negative pid = the runner's whole process group
  for (let i = 0; i < 50 && store.runnerPid(name) !== null; i++) await sleep(100);
  if (store.runnerPid(name) !== null) process.kill(-pid, 'SIGKILL');
  // the caller stopped it knowingly, dont hand the stopped turn back as news on the next wait
  const turn = store.loadTurn(name);
  if (turn?.ended) store.markReported(name, turn.n);
  return true;
}

async function stop(args: string[]): Promise<void> {
  const { name } = existing(args[0]);
  console.log((await halt(name)) ? `${name}: stopped. Its conversation is kept, run it again to continue` : `${name}: was not running`);
}

async function rm(args: string[]): Promise<void> {
  const worker = existing(args[0]);
  await halt(worker.name);
  store.removeWorker(worker.name);
  console.log(`${worker.name}: removed`);
  if (worker.branch) console.log(`${worker.name}: its worktree stays at ${worker.cwd} (branch ${worker.branch}). After merging: git worktree remove ${worker.cwd}`);
}

const commands: Record<string, (args: string[]) => unknown> = {
  run, wait, list, log, stop, rm,
  _work: (args) => work(args[0]!),  // the detached runner, started by run
  help: () => console.log(HELP),
};

const [command = 'help', ...args] = process.argv.slice(2);
try {
  await (commands[command] ?? (() => fail(`unknown command ${command}\n\n${HELP}`)))(args);
} catch (err) {
  fail((err as Error).message);
}
