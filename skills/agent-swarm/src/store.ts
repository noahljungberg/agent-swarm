// Everything a worker is, as files under ~/.agent-swarm/workers/<name>/:
//   worker.json  who it is + its engine session id
//   queue/       tasks waiting for a turn, oldest first
//   turns/       one file per turn: task, reply or error
//   reported     the last turn `wait` has printed
//   log.txt      what it did, line by line
//   pid          held by the runner while it drains the queue

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env['AGENT_SWARM_HOME'] ?? join(homedir(), '.agent-swarm');

export interface Worker {
  name: string;
  engine: string;
  cwd: string;
  model: string;
  effort?: string | undefined;
  branch?: string | undefined;  // set when we made it a worktree
  session: string | null;       // null until its first turn starts
}

export interface Turn {
  n: number;
  task: string;
  started: string;
  ended?: string;        // missing while running, or forever if the runner died
  ok?: boolean;
  reply?: string;
  error?: string;
}

export const path = (name: string, file = '') => join(HOME, 'workers', name, file);

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; }
}

// write-then-rename so a reader never sees half a file
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export const loadWorker = (name: string) => readJson<Worker>(path(name, 'worker.json'));
export function saveWorker(worker: Worker): void {
  mkdirSync(path(worker.name, 'queue'), { recursive: true });
  mkdirSync(path(worker.name, 'turns'), { recursive: true });
  writeAtomic(path(worker.name, 'worker.json'), JSON.stringify(worker, null, 2));
}
export const removeWorker = (name: string) => rmSync(path(name), { recursive: true, force: true });
export function listWorkers(): string[] {
  try { return readdirSync(join(HOME, 'workers')).sort(); } catch { return []; }
}

// --- turns ---

function turnFiles(name: string): string[] {
  try { return readdirSync(path(name, 'turns')).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
}
export const loadTurns = (name: string) => turnFiles(name).map((f) => readJson<Turn>(path(name, `turns/${f}`))).filter((t) => t !== null);
export function loadTurn(name: string): Turn | null {  // the latest one
  const last = turnFiles(name).at(-1);
  return last ? readJson<Turn>(path(name, `turns/${last}`)) : null;
}
export function saveTurn(name: string, turn: Turn): void {
  writeAtomic(path(name, `turns/${String(turn.n).padStart(6, '0')}.json`), JSON.stringify(turn, null, 2));
}

export const reported = (name: string) => Number(readJson<number>(path(name, 'reported')) ?? 0);
export const markReported = (name: string, n: number) => writeAtomic(path(name, 'reported'), String(n));

// --- queue ---

function queued(name: string): string[] {
  try { return readdirSync(path(name, 'queue')).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
}
export const queueLength = (name: string) => queued(name).length;
export function enqueue(name: string, task: string): void {
  // ms timestamp first so the sort is arrival order
  writeAtomic(path(name, `queue/${Date.now()}-${randomBytes(3).toString('hex')}.md`), task);
}
export function nextTask(name: string): string | null {
  const [first] = queued(name);
  if (!first) return null;
  const task = readFileSync(path(name, `queue/${first}`), 'utf8');
  rmSync(path(name, `queue/${first}`));
  return task;
}
export function clearQueue(name: string): void {
  for (const f of queued(name)) rmSync(path(name, `queue/${f}`));
}

// --- runner lock ---

// Pid of the live runner, or null. Checks the command too, a stale pid can get reused by something else
export function runnerPid(name: string): number | null {
  const pid = Number(readJson<number>(path(name, 'pid')));
  if (!pid) return null;
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return command.includes(`_work ${name}`) ? pid : null;
  } catch { return null; }
}

// ponytail: clearing a stale lock isn't atomic, two runners starting right after a crashed one could both win.
// needs a kill -9 plus a same-ms double start, use flock if it ever shows up
export function lock(name: string): boolean {
  if (runnerPid(name) === null) rmSync(path(name, 'pid'), { force: true });
  try { writeFileSync(path(name, 'pid'), String(process.pid), { flag: 'wx' }); return true; } catch { return false; }
}
export const unlock = (name: string) => rmSync(path(name, 'pid'), { force: true });

// --- log ---

export function log(name: string, text: string): void {
  appendFileSync(path(name, 'log.txt'), `${new Date().toTimeString().slice(0, 8)} ${text}\n`);
}
export function readLog(name: string, lines: number): string {
  try { return readFileSync(path(name, 'log.txt'), 'utf8').trimEnd().split('\n').slice(-lines).join('\n'); } catch { return ''; }
}
