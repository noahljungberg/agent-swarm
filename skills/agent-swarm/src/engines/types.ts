// The contract between the worker loop and an engine. Types only

export interface TurnRequest {
  session: string | null;       // the engine's own conversation id, null -> start a fresh one
  prompt: string;
  rules: string;                // standing worker rules, goes in the engine's system-level slot
  cwd: string;
  model: string;
  effort?: string | undefined;  // unset -> the engine's own default
  onSession(id: string): void;  // called as soon as the id is known, so a killed turn stays resumable
  onLog(line: string): void;    // one line per thing the worker did
}

export interface TurnResult {
  session: string;
  reply: string;
}

// One turn = one engine process. It resumes req.session, runs the prompt, exits
export type Engine = (req: TurnRequest) => Promise<TurnResult>;

export class EngineError extends Error {}

// The engine no longer has the saved session (pruned transcript, wiped home) -> caller starts over fresh
export class SessionLostError extends EngineError {}
