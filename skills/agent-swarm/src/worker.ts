// The runner: one detached process per busy worker. Drains the queue a turn at a time, then exits.
// Nothing stays alive between tasks, the engine's saved session is what carries the context

import { ENGINES } from './engines/index.ts';
import { SessionLostError } from './engines/types.ts';
import { git } from './git.ts';
import * as store from './store.ts';

// Sent with every turn, so the orchestrator's task can be just the task
const rules = (cwd: string) => `You are a worker agent. An orchestrator agent gives you tasks and reads your replies; no human is watching this session.
- Work only inside ${cwd}.
- Read AGENTS.md / CLAUDE.md first if present, and follow them.
- Do not commit, push, merge or deploy, and do not touch production. Leave your changes uncommitted in the working tree: the orchestrator reviews and commits them.
- If the task is ambiguous or you are blocked, stop and say exactly what you need instead of guessing.
- End every reply with: what you changed, what you ran to verify it and the result, and any blockers or open questions.`;

function endTurn(worker: store.Worker, turn: store.Turn, outcome: { ok: boolean; reply?: string; error?: string }): void {
  let uncommitted = '';
  try { uncommitted = git(worker.cwd, 'status', '--short'); } catch { /* cwd is not a repo */ }
  store.saveTurn(worker.name, { ...turn, ...outcome, ended: new Date().toISOString(), uncommitted });
  store.log(worker.name, outcome.ok ? `turn ${turn.n} done\n${outcome.reply}` : `turn ${turn.n} failed: ${outcome.error}`);
}

async function runTurn(name: string, task: string): Promise<void> {
  const worker = store.loadWorker(name)!;
  const turn: store.Turn = { n: (store.loadTurn(name)?.n ?? 0) + 1, task, started: new Date().toISOString() };
  store.saveTurn(name, turn);
  const oneLine = (text: string) => text.replace(/\s+/g, ' ').slice(0, 300);
  store.log(name, `turn ${turn.n} started: ${oneLine(task)}`);
  const attempt = (session: string | null) => ENGINES[worker.engine]!.turn({
    session, prompt: task, rules: rules(worker.cwd), cwd: worker.cwd, model: worker.model, effort: worker.effort,
    onSession: (id) => store.saveWorker({ ...worker, session: id }),
    onLog: (line) => store.log(name, oneLine(line)),
  });
  try {
    let lost = '';
    const result = await attempt(worker.session).catch((err) => {
      if (!(err instanceof SessionLostError)) throw err;
      lost = '(this worker\'s earlier conversation is gone, it started fresh without that context)\n';
      return attempt(null);
    });
    endTurn(worker, turn, { ok: true, reply: lost + result.reply });
  } catch (err) {
    endTurn(worker, turn, { ok: false, error: (err as Error).message });
  }
}

export async function work(name: string): Promise<void> {
  if (!store.lock(name)) return;  // another runner already has it
  // `stop` SIGTERMs our whole process group, so the engine and its tools die with us
  process.on('SIGTERM', () => {
    const worker = store.loadWorker(name);
    const turn = store.loadTurn(name);
    if (worker && turn && !turn.ended) endTurn(worker, turn, { ok: false, error: 'stopped' });
    store.unlock(name);
    process.exit(0);
  });
  for (;;) {
    for (let task; (task = store.nextTask(name)) !== null;) await runTurn(name, task);
    store.unlock(name);
    // a task can land between the last check and the unlock
    if (store.queueLength(name) === 0 || !store.lock(name)) return;
  }
}
