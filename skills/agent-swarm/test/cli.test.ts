// The whole tool through its real surface: the CLI, a detached runner, and fake claude/codex on PATH

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const STUBS = fileURLToPath(new URL('./stubs', import.meta.url));

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-')));
  const env = { ...process.env, AGENT_SWARM_HOME: join(home, 'state'), FAKE_ENGINE_HOME: home, PATH: `${STUBS}:${process.env['PATH']}` };
  const swarm = (args: string[], cwd = home) => spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: 'utf8' });
  return { home, swarm };
}

for (const engine of ['codex', 'claude']) {
  test(`${engine}: a second task continues the same conversation`, () => {
    const { home, swarm } = sandbox();
    assert.match(swarm(['run', 'a', '--engine', engine, '--', 'hello there']).stdout, /a: working/);
    let waited = swarm(['wait', 'a']);
    assert.equal(waited.status, 0);
    assert.match(waited.stdout, /== a: done, turn 1/);
    assert.match(waited.stdout, /turn 1: hello there/);

    swarm(['run', 'a', '--', 'again']);
    waited = swarm(['wait', 'a']);
    assert.match(waited.stdout, /turn 2: again/);  // the fake counts turns per session, so 2 = it was resumed
    assert.match(swarm(['log', 'a']).stdout, /\$ echo hi/);

    const sent = readFileSync(join(home, `${engine}-args.json`), 'utf8');
    assert.match(sent, engine === 'codex' ? /gpt-6-astra/ : /claude-opus-5-5/);
    assert.match(sent, /You are a worker agent/);
  });

  test(`${engine}: a task for a busy worker queues behind the turn`, () => {
    const { swarm } = sandbox();
    swarm(['run', 'a', '--engine', engine, '--', 'sleep 400 one']);
    assert.match(swarm(['run', 'a', '--', 'two']).stdout, /queued behind/);
    // one reply back per task given, then only the last one again
    assert.match(swarm(['wait']).stdout, /== a: done, turn 1[^]*turn 1: sleep 400 one[^]*== a: done, turn 2[^]*turn 2: two/);
    const again = swarm(['wait', 'a']).stdout;
    assert.match(again, /turn 2: two/);
    assert.doesNotMatch(again, /turn 1: sleep/);
  });

  test(`${engine}: a failed turn fails the wait`, () => {
    const { swarm } = sandbox();
    swarm(['run', 'a', '--engine', engine, '--', 'FAIL']);
    const waited = swarm(['wait', 'a']);
    assert.equal(waited.status, 1);
    assert.match(waited.stdout, /== a: failed, turn 1[^]*boom/);
  });

  test(`${engine}: stop cuts the turn, the next task still resumes`, () => {
    const { swarm } = sandbox();
    swarm(['run', 'a', '--engine', engine, '--', 'sleep 60000 forever']);
    while (!/echo hi/.test(swarm(['log', 'a']).stdout)) { /* until the turn is really running */ }
    assert.equal(swarm(['wait', 'a', '--timeout', '1']).status, 124);
    assert.match(swarm(['stop', 'a']).stdout, /a: stopped/);
    assert.match(swarm(['list']).stdout, /a\s+stopped/);
    swarm(['run', 'a', '--', 'back']);
    const waited = swarm(['wait', 'a']);
    assert.match(waited.stdout, /turn 2: back/);
    assert.equal(waited.status, 0);  // our own stop is not reported back as a failure
  });

  test(`${engine}: a lost session starts fresh and says so`, () => {
    const { home, swarm } = sandbox();
    swarm(['run', 'a', '--engine', engine, '--', 'one']);
    swarm(['wait', 'a']);
    for (const f of readdirSync(home)) if (f.startsWith(`${engine}-`)) rmSync(join(home, f));
    swarm(['run', 'a', '--', 'two']);
    assert.match(swarm(['wait', 'a']).stdout, /earlier conversation is gone[^]*turn 1: two/);
  });
}

test('a name from another project is refused', () => {
  const { home, swarm } = sandbox();
  mkdirSync(join(home, 'one'));
  mkdirSync(join(home, 'two'));
  swarm(['run', 'a', '--engine', 'claude', '--', 'x'], join(home, 'one'));
  swarm(['wait', 'a']);
  const other = swarm(['run', 'a', '--', 'y'], join(home, 'two'));
  assert.equal(other.status, 2);
  assert.match(other.stderr, /belongs to another project/);
  assert.match(swarm(['run', 'a', '--cwd', join(home, 'one'), '--', 'y'], join(home, 'two')).stdout, /a: working/);
  swarm(['wait', 'a']);
});

test('--worktree hires into its own worktree, wait lists what is uncommitted', () => {
  const { home, swarm } = sandbox();
  const repo = join(home, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  const tree = join(home, 'state', 'worktrees', 'repo-w');

  assert.match(swarm(['run', 'w', '--engine', 'claude', '--worktree', '--', 'touch made.txt'], repo).stdout, /on new branch agent\/w/);
  const waited = swarm(['wait', 'w']).stdout;
  assert.match(waited, /uncommitted in .*repo-w:\n\?\? made\.txt/);
  assert.ok(existsSync(join(tree, 'made.txt')));
  assert.ok(!existsSync(join(repo, 'made.txt')));

  // from the main checkout the same name reaches the same worker
  swarm(['run', 'w', '--', 'more'], repo);
  assert.match(swarm(['wait', 'w']).stdout, /turn 2: more/);

  // uncommitted is read live: once the orchestrator commits, wait stops listing it
  execFileSync('git', ['add', '-A'], { cwd: tree });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'made'], { cwd: tree });
  assert.doesNotMatch(swarm(['wait', 'w']).stdout, /uncommitted/);

  assert.equal(swarm(['wait', 'w', '--timeout', '10m']).status, 2);
  assert.equal(swarm(['rm', '../..']).status, 2);
  assert.match(swarm(['rm', 'w']).stdout, /worktree stays at/);
  assert.ok(existsSync(tree));
});
