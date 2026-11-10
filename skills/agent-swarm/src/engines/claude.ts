import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { EngineError, SessionLostError, type TurnRequest, type TurnResult } from './types.ts';

type Json = Record<string, any>;

function toolLine(name: string, input: Json): string {
  if (name === 'Bash') return `$ ${input['command']}`;
  return `${name} ${input['file_path'] ?? input['path'] ?? input['pattern'] ?? input['description'] ?? ''}`.trim();
}

// One `claude -p` per turn. The conversation lives in claude's own store, --resume picks it up
export function claudeTurn(req: TurnRequest): Promise<TurnResult> {
  const fresh = req.session === null;
  const session = req.session ?? randomUUID();
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', req.model, ...(req.effort ? ['--effort', req.effort] : []),
    fresh ? '--session-id' : '--resume', session,
    '--append-system-prompt', req.rules,
    '--permission-mode', 'auto',  // plain -p declines file writes
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: req.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});  // it may exit before reading it all, its output says why
    child.stdin.end(req.prompt);        // stdin, not argv: a prompt can outgrow the argv limit
    let result: Json | null = null;
    let tail = '';
    createInterface({ input: child.stdout }).on('line', (line) => {
      let event: Json;
      try { event = JSON.parse(line) as Json; } catch { tail = line; return; }
      if (event['type'] === 'system' && event['subtype'] === 'init') req.onSession(String(event['session_id']));
      else if (event['type'] === 'result') result = event;
      else if (event['type'] === 'assistant') {
        for (const block of (event['message']?.content ?? []) as Json[]) {
          if (block['type'] === 'text' && block['text'].trim()) req.onLog(`says: ${block['text']}`);
          if (block['type'] === 'tool_use') req.onLog(toolLine(block['name'], block['input'] ?? {}));
        }
      }
    });
    createInterface({ input: child.stderr }).on('line', (line) => { if (line.trim()) tail = line; });
    child.on('error', (err) => reject(new EngineError(`can't run claude: ${err.message}`)));
    child.on('close', (code) => {
      if (result && !result['is_error']) {
        resolve({ session: String(result['session_id'] ?? session), reply: String(result['result'] ?? '') });
        return;
      }
      // a failed --resume reports in `errors`, not `result`
      const message = [result?.['result'], ...(result?.['errors'] ?? [])].filter(Boolean).join(' ') || tail || `claude exited ${code}`;
      reject(!fresh && /no conversation found/i.test(message) ? new SessionLostError(message) : new EngineError(message));
    });
  });
}
