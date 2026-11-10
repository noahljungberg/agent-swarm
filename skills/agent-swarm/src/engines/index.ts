import { claudeTurn } from './claude.ts';
import { codexTurn } from './codex.ts';
import type { Engine } from './types.ts';

// The one place model policy lives. No effort -> the engine's own default
export const ENGINES: Record<string, { turn: Engine; model: string; effort?: string }> = {
  codex: { turn: codexTurn, model: 'gpt-6-astra', effort: 'xhigh' },
  claude: { turn: claudeTurn, model: 'claude-opus-5-5' },
};
