import { execFileSync } from 'node:child_process';

// Runs git in cwd, returns trimmed stdout. Throws with git's own message
export function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  } catch (err) {
    throw new Error(String((err as { stderr?: string }).stderr || (err as Error).message).trim());
  }
}
