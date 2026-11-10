import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EngineError, SessionLostError, type TurnRequest, type TurnResult } from './types.ts';

type Json = Record<string, any>;

// Newline JSON-RPC over a subprocess: the app-server wire format
class Rpc {
  private nextId = 0;
  private waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private child: ChildProcess;
  onNotify: (method: string, params: Json) => void = () => {};

  constructor(child: ChildProcess) {
    this.child = child;
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let msg: Json;
      try { msg = JSON.parse(line) as Json; } catch { return; }
      if ('method' in msg && 'id' in msg) {
        // Server asking us something. approvalPolicy=never means none should come, decline what does
        const reply = String(msg['method']).endsWith('requestApproval')
          ? { result: { decision: 'decline' } }
          : { error: { code: -32601, message: 'not supported by agent-swarm' } };
        this.send({ id: msg['id'], ...reply });
      } else if ('method' in msg) {
        this.onNotify(String(msg['method']), (msg['params'] as Json) ?? {});
      } else {
        const waiter = this.waiting.get(msg['id'] as number);
        if (!waiter) return;
        this.waiting.delete(msg['id'] as number);
        if (msg['error']) waiter.reject(new EngineError(String(msg['error'].message ?? JSON.stringify(msg['error']))));
        else waiter.resolve((msg['result'] as Json) ?? {});
      }
    });
    child.on('close', () => {
      for (const w of this.waiting.values()) w.reject(new EngineError('codex app-server exited'));
      this.waiting.clear();
      this.onNotify('_exit', {});
    });
  }

  send(msg: Json): void { this.child.stdin!.write(`${JSON.stringify(msg)}\n`); }

  request(method: string, params: Json = {}): Promise<Json> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }
}

// Runs one turn on a started thread, resolves with the agent's last message
async function runTurn(rpc: Rpc, threadId: string, req: TurnRequest): Promise<string> {
  let reply = '';
  const done = new Promise<string>((resolve, reject) => {
    rpc.onNotify = (method, params) => {
      if (method === 'item/completed') {
        const item = (params['item'] ?? {}) as Json;
        if (item['type'] === 'agentMessage') { reply = String(item['text'] ?? reply); req.onLog(`says: ${reply}`); }
        else if (item['type'] === 'commandExecution') req.onLog(`$ ${item['command']} -> exit ${item['exitCode']}`);
        else if (item['type'] === 'fileChange') req.onLog(`edit ${(item['changes'] as Json[]).map((c) => c['path']).join(', ')}`);
      } else if (method === 'turn/completed') {
        const turn = (params['turn'] ?? {}) as Json;
        if (turn['status'] === 'completed') resolve(reply);
        else reject(new EngineError(`codex turn ${turn['status']}: ${turn['error']?.message ?? JSON.stringify(turn['error'] ?? {})}`));
      } else if (method === 'error' && !params['willRetry']) reject(new EngineError(String(params['error']?.message ?? 'codex error')));
      else if (method === '_exit') reject(new EngineError('codex app-server exited mid-turn'));
    };
  });
  done.catch(() => {});  // if turn/start itself fails that error is the one thrown, this one must not go unhandled
  await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: req.prompt }], ...(req.effort ? { effort: req.effort } : {}) });
  return await done;
}

// One `codex app-server` per turn: thread/resume picks the conversation up, and a fresh process can't carry stale state
export async function codexTurn(req: TurnRequest): Promise<TurnResult> {
  const child = spawn('codex', ['app-server'], { cwd: req.cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (err) => reject(new EngineError(`can't run codex: ${err.message}`)));
  });
  const rpc = new Rpc(child);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'agent-swarm', version: '1' } });
    rpc.send({ method: 'initialized' });
    // never-ask + workspace-write: unattended, can edit the cwd, cant write .git (codex protects it on purpose)
    const options = { cwd: req.cwd, model: req.model, sandbox: 'workspace-write', approvalPolicy: 'never', developerInstructions: req.rules };
    let started: Json;
    if (req.session) {
      started = await rpc.request('thread/resume', { ...options, threadId: req.session, excludeTurns: true }).catch((err: Error) => {
        throw /no rollout found/i.test(err.message) ? new SessionLostError(err.message) : err;
      });
    } else {
      started = await rpc.request('thread/start', options);
    }
    const threadId = String(started['thread']?.id);
    req.onSession(threadId);
    return { session: threadId, reply: await runTurn(rpc, threadId, req) };
  } finally {
    child.kill();
  }
}
