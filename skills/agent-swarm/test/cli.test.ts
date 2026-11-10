// The whole tool through its real surface: the CLI, a detached runner, and fake claude/codex on PATH

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const STUBS = fileURLToPath(new URL('./stubs', import.meta.url));

const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

function sandbox(path = `${STUBS}:${process.env['PATH']}`) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-')));
  homes.push(home);
  const env = { ...process.env, AGENT_SWARM_HOME: join(home, 'state'), FAKE_ENGINE_HOME: home, PATH: path };
  const swarm = (args: string[], cwd = home) => spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: 'utf8' });
  return { home, swarm };
}

function until(what: string, condition: () => boolean): void {
  for (const deadline = Date.now() + 15_000; !condition();) {
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`);
  }
}

function repo(dir: string): string {
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
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
    until('the turn is running', () => /echo hi/.test(swarm(['log', 'a']).stdout));
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

test('wait with no names still returns a turn that finished before it was called', () => {
  const { swarm } = sandbox();
  swarm(['run', 'a', '--engine', 'claude', '--', 'FAIL']);
  until('a has failed', () => /a\s+failed/.test(swarm(['list']).stdout));
  const waited = swarm(['wait']);
  assert.match(waited.stdout, /== a: failed, turn 1/);
  assert.equal(waited.status, 1);
  assert.match(swarm(['wait']).stdout, /nothing to wait for/);
});

test('a timed out wait does not repeat the previous task\'s reply', () => {
  const { swarm } = sandbox();
  swarm(['run', 'a', '--engine', 'claude', '--', 'one']);
  swarm(['wait', 'a']);
  swarm(['run', 'a', '--', 'sleep 60000 two']);
  const timedOut = swarm(['wait', 'a', '--timeout', '1']);
  assert.equal(timedOut.status, 124);
  assert.doesNotMatch(timedOut.stdout, /turn 1: one/);
  swarm(['stop', 'a']);
});

test('stop keeps the replies that were not printed yet', () => {
  const { swarm } = sandbox();
  swarm(['run', 'a', '--engine', 'claude', '--', 'one']);
  until('turn 1 is done', () => /a\s+done/.test(swarm(['list']).stdout));
  swarm(['run', 'a', '--', 'sleep 60000 two']);
  until('turn 2 is running', () => /turn 2 started[^]*echo hi/.test(swarm(['log', 'a']).stdout));
  swarm(['stop', 'a']);
  assert.match(swarm(['wait', 'a']).stdout, /turn 1: one/);
});

test('stop also kills a tool process that ignores TERM', () => {
  const { home, swarm } = sandbox();
  swarm(['run', 'a', '--engine', 'claude', '--', 'stubborn late.txt sleep 60000']);
  until('the turn is running', () => /echo hi/.test(swarm(['log', 'a']).stdout));
  swarm(['stop', 'a']);
  spawnSync('sleep', ['4.5']);  // past the moment the child would have written
  assert.ok(!existsSync(join(home, 'late.txt')));
});

test('a live runner is not called dead when ps is unusable', () => {
  // /usr/bin has env and git but, on macOS, no ps
  const { swarm } = sandbox(`${STUBS}:${dirname(process.execPath)}:/usr/bin`);
  swarm(['run', 'a', '--engine', 'claude', '--', 'sleep 3000 x']);
  until('the turn is running', () => /echo hi/.test(swarm(['log', 'a']).stdout));
  assert.match(swarm(['list']).stdout, /a\s+busy/);
  assert.match(swarm(['wait', 'a']).stdout, /== a: done, turn 1/);
});

test('a name only resolves inside its own project', () => {
  const { home, swarm } = sandbox();
  const [one, two] = [join(home, 'one'), join(home, 'two')];
  mkdirSync(one);
  mkdirSync(two);
  swarm(['run', 'a', '--engine', 'claude', '--', 'x'], one);
  until('a is done', () => /a\s+done/.test(swarm(['list']).stdout));

  const other = swarm(['run', 'a', '--', 'y'], two);
  assert.equal(other.status, 2);
  assert.match(other.stderr, /belongs to another project/);
  for (const command of ['wait', 'stop', 'log', 'rm']) assert.equal(swarm([command, 'a'], two).status, 2, command);
  assert.match(swarm(['wait'], two).stdout, /nothing to wait for/);  // and does not eat a's unread reply

  assert.match(swarm(['wait'], one).stdout, /turn 1: x/);
  assert.match(swarm(['run', 'a', '--cwd', one, '--', 'y'], two).stdout, /a: working/);
  swarm(['wait', 'a'], one);
});

test('--worktree hires into its own worktree, wait lists what is uncommitted', () => {
  const { home, swarm } = sandbox();
  const main = repo(join(home, 'repo'));
  const tree = join(home, 'state', 'worktrees', 'repo-w');

  assert.match(swarm(['run', 'w', '--engine', 'claude', '--worktree', '--', 'touch made.txt'], main).stdout, /on new branch agent\/w/);
  assert.match(swarm(['wait', 'w'], main).stdout, /uncommitted in .*repo-w:\n\?\? made\.txt/);
  assert.ok(existsSync(join(tree, 'made.txt')));
  assert.ok(!existsSync(join(main, 'made.txt')));

  // from the main checkout the same name reaches the same worker, and repeating the hiring flags is fine
  swarm(['run', 'w', '--worktree', '--', 'more'], main);
  assert.match(swarm(['wait', 'w'], main).stdout, /turn 2: more/);

  // uncommitted is read live: once the orchestrator commits, wait stops listing it
  execFileSync('git', ['add', '-A'], { cwd: tree });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'made'], { cwd: tree });
  assert.doesNotMatch(swarm(['wait', 'w'], main).stdout, /uncommitted/);

  assert.equal(swarm(['wait', 'w', '--timeout', '10m'], main).status, 2);
  assert.equal(swarm(['rm', '../..'], main).status, 2);
  assert.match(swarm(['rm', 'w'], main).stdout, /worktree stays at/);
  assert.ok(existsSync(tree));

  // hired again under the same name, it gets its old worktree back with a fresh conversation
  assert.match(swarm(['run', 'w', '--engine', 'claude', '--worktree', '--', 'again'], main).stdout, /back in its worktree/);
  assert.match(swarm(['wait', 'w'], main).stdout, /turn 1: again/);
});

test('hiring flags an existing worker cannot honour are refused', () => {
  const { home, swarm } = sandbox();
  const main = repo(join(home, 'repo'));
  mkdirSync(join(main, 'sub'));
  swarm(['run', 'h', '--engine', 'claude', '--', 'x'], main);
  swarm(['wait', 'h'], main);
  const worktree = swarm(['run', 'h', '--worktree', '--', 'y'], main);
  assert.equal(worktree.status, 2);
  assert.match(worktree.stderr, /without a worktree/);
  assert.equal(swarm(['run', 'h', '--cwd', join(main, 'sub'), '--', 'y'], main).status, 2);
  assert.equal(swarm(['run', 'h', '--engine', 'codex', '--', 'y'], main).status, 2);
});
