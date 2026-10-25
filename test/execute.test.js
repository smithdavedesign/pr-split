// M2 deliverables beyond the exit criteria: retries, failure handling, commit messages, push, flags.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { commitMessage } from '../src/plan.js';
import {
  API_FILES,
  DB_FILES,
  addBareRemote,
  branches,
  capture,
  commitAll,
  configYaml,
  git,
  makeRepo,
  scriptEnv,
  writeFiles,
} from './helpers.js';

const quote = (path) => `'${path.replaceAll("'", "'\\''")}'`;
const CONVENTIONAL = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)\([a-z0-9-]+\): \S/;

/** The M1 fixture (5 database + 5 API files) with a .pr-split.yml on main. */
const makeSplitRepo = (config = {}, extra = {}) =>
  makeRepo({ base: { '.pr-split.yml': configYaml(config), ...extra }, feature: { ...DB_FILES, ...API_FILES } });

async function run(repo, args, env = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(['--base', 'main', '--no-llm', ...args], {
    cwd: repo.dir,
    env: scriptEnv(env),
    stdout,
    stderr,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

const head = (repo) => git(repo.dir, 'symbolic-ref', '--short', 'HEAD');
const clean = (repo) => git(repo.dir, 'status', '--porcelain', '--untracked-files=no') === '';
const message = (repo, ref) => git(repo.dir, 'log', '-1', '--format=%B', ref);

let markers;
let repo;
let remote;
beforeEach(() => {
  markers = mkdtempSync(join(tmpdir(), 'pr-split-markers-'));
});
afterEach(() => {
  repo?.cleanup();
  remote?.cleanup();
  repo = undefined;
  remote = undefined;
  rmSync(markers, { recursive: true, force: true });
});

/** A command that fails until it has been run `passOn` times in total, counting runs in a file. */
function flaky(passOn) {
  const counter = quote(join(markers, 'count'));
  return `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n + 1)); echo $n > ${counter}; [ $n -ge ${passOn} ]`;
}
const runs = () => Number(readFileSync(join(markers, 'count'), 'utf8'));

describe('--execute: configurable validation retries', () => {
  it('retries a failing validation command up to "retries" times from .pr-split.yml', async () => {
    repo = makeSplitRepo({ retries: 1, validate: { test: flaky(2) } });
    const { code, stderr } = await run(repo, ['--execute']);
    expect(code, stderr).toBe(0);
    expect(stderr).toMatch(/validation "test" failed on pr-split\/01-database; retrying \(attempt 2 of 2\)/);
    expect(runs()).toBe(3); // layer 1: fail + pass, layer 2: pass
    expect(branches(repo.dir)).toEqual(['pr-split/01-database', 'pr-split/02-api']);
  });

  it('does not retry by default', async () => {
    repo = makeSplitRepo({ validate: { test: flaky(2) } });
    const { code, stderr } = await run(repo, ['--execute']);
    expect(code).toBe(1);
    expect(runs()).toBe(1);
    expect(stderr).toMatch(/validation "test" failed on pr-split\/01-database \(exit code 1, 1 attempt\)/);
  });

  it('--retries overrides the config and gives up after retries + 1 attempts', async () => {
    repo = makeSplitRepo({ retries: 0, validate: { test: flaky(99) } });
    const { code, stderr } = await run(repo, ['--execute', '--retries', '2']);
    expect(code).toBe(1);
    expect(runs()).toBe(3);
    expect(stderr).toMatch(/validation "test" failed on pr-split\/01-database \(exit code 1, 3 attempts\)/);
  });

  it.each(['-1', 'two', '1.5', '11'])('rejects --retries %s with exit 2', async (value) => {
    repo = makeSplitRepo();
    const { code, stderr } = await run(repo, [`--retries=${value}`]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--retries/);
  });

  it('shows the retry count in the summary and the script', async () => {
    repo = makeSplitRepo({ retries: 2, validate: { test: 'true' } });
    const { code, stdout } = await run(repo, []);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Validation after each layer: test \(retried up to 2 times\)/);
    expect(readFileSync(join(repo.dir, 'pr-split.sh'), 'utf8')).toContain('\nRETRIES=2\n');
  });
});

describe('--execute: the validation commands are shown before anything runs', () => {
  it('lists each command from .pr-split.yml in the summary, ahead of the script output', async () => {
    repo = makeSplitRepo({ validate: { build: 'node -e "process.exit(0)"', lint: 'echo one\necho two' } });
    const { code, stdout } = await run(repo, ['--execute']);
    expect(code).toBe(0);
    const listed = stdout.indexOf('  build: node -e "process.exit(0)"\n');
    expect(listed).toBeGreaterThan(-1);
    expect(listed).toBeLessThan(stdout.indexOf('+ git checkout'));
    // A newline in the command must not start a line of its own in the summary.
    expect(stdout).toContain('  lint: echo one echo two\n');
  });
});

describe('--execute: a failing step stops the run and reports which branch failed', () => {
  it('stops at the first layer that fails, names it, and goes back to the feature branch', async () => {
    repo = makeSplitRepo({ validate: { check: 'test "$(git branch --show-current)" != pr-split/02-api' } });
    const { code, stdout, stderr } = await run(repo, ['--execute']);
    expect(code).toBe(1);
    expect(stdout).toMatch(/2 stacked PRs/); // the plan is shown before anything runs
    expect(stderr).toMatch(/FAILED on pr-split\/02-api: validation "check" failed on pr-split\/02-api \(exit code 1, 1 attempt\)/);
    expect(stderr).toContain('git checkout pr-split/02-api');
    expect(stderr).toMatch(/passed validation before the failure: pr-split\/01-database/);
    expect(stderr).toMatch(/back on feature\/split-me/);
    expect(head(repo)).toBe(repo.featureBranch);
    expect(clean(repo)).toBe(true);
    expect(git(repo.dir, 'branch', '--list', 'pr-split/tmp/*')).toBe('');
    // The failed layer keeps its commit so it can be inspected; nothing is built after it.
    expect(git(repo.dir, 'diff', '--name-only', 'pr-split/01-database', 'pr-split/02-api').split('\n').sort()).toEqual(
      Object.keys(API_FILES).sort(),
    );
  });

  it('reports the failure in --json output', async () => {
    repo = makeSplitRepo({ validate: { check: 'exit 3' } });
    const { code, stdout } = await run(repo, ['--execute', '--json']);
    expect(code).toBe(1);
    const plan = JSON.parse(stdout);
    expect(plan.execution).toEqual({ ok: false, exitCode: 3 });
  });

  it('aborts a conflicting cherry-pick and explains how to fix it', async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `-- line ${i + 1}`);
    repo = makeRepo({
      base: { 'db/schema.sql': `${lines.join('\n')}\n` },
      feature: { 'db/schema.sql': `-- feature edit\n${lines.slice(1).join('\n')}\n`, 'src/api/a.js': '1\n' },
    });
    git(repo.dir, 'checkout', '-q', 'main');
    writeFiles(repo.dir, { 'db/schema.sql': `-- upstream edit\n${lines.slice(1).join('\n')}\n` });
    commitAll(repo.dir, 'conflicting upstream change');
    git(repo.dir, 'checkout', '-q', repo.featureBranch);
    const { code, stderr } = await run(repo, ['--execute']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/FAILED on pr-split\/01-database: .*git cherry-pick/);
    expect(stderr).toMatch(/aborted the cherry-pick/);
    expect(stderr).toMatch(/rebase feature\/split-me onto main/);
    expect(() => git(repo.dir, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD')).toThrow();
    expect(head(repo)).toBe(repo.featureBranch);
    expect(clean(repo)).toBe(true);
  });

  it('fails when validation changes tracked files, and keeps those changes in a stash', async () => {
    repo = makeSplitRepo({ validate: { format: 'echo formatted >> README.md' } });
    const before = git(repo.dir, 'rev-parse', 'HEAD');
    const { code, stderr } = await run(repo, ['--execute']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/FAILED on pr-split\/01-database: the validation commands changed tracked files/);
    expect(stderr).toContain('README.md');
    expect(stderr).toMatch(/git stash/);
    expect(git(repo.dir, 'stash', 'list')).toMatch(/pr-split/);
    expect(head(repo)).toBe(repo.featureBranch);
    expect(git(repo.dir, 'rev-parse', 'HEAD')).toBe(before);
    expect(clean(repo)).toBe(true);
    expect(branches(repo.dir)).toEqual(['pr-split/01-database']);
  });

  it('fails when validation commits or switches branches, so no layer carries extra commits', async () => {
    repo = makeSplitRepo({ validate: { sneaky: 'git commit -q --allow-empty -m "made by a validation hook"' } });
    const { code, stderr } = await run(repo, ['--execute']);
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /FAILED on pr-split\/01-database: the validation commands switched branches or made commits; pr-split\/01-database must be exactly one commit on top of main/,
    );
    expect(head(repo)).toBe(repo.featureBranch);
    expect(branches(repo.dir)).toEqual(['pr-split/01-database']);

    repo.cleanup();
    repo = makeSplitRepo({ validate: { wander: 'git checkout -q main' } });
    const wandered = await run(repo, ['--execute']);
    expect(wandered.code).toBe(1);
    expect(wandered.stderr).toMatch(/switched branches or made commits/);
    expect(head(repo)).toBe(repo.featureBranch);
  });

  it('refuses to start on a dirty working tree', async () => {
    repo = makeSplitRepo({ validate: { test: 'true' } });
    writeFiles(repo.dir, { 'README.md': 'uncommitted\n' });
    const { code, stderr } = await run(repo, ['--execute']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/commit or stash your changes first/);
    expect(branches(repo.dir)).toEqual([]);
    expect(readFileSync(join(repo.dir, 'README.md'), 'utf8')).toBe('uncommitted\n');
  });

  it('warns when --execute has no validation commands to run', async () => {
    repo = makeSplitRepo();
    const { code, stderr } = await run(repo, ['--execute']);
    expect(code).toBe(0);
    expect(stderr).toMatch(/warning: --execute without validation commands/);
    expect(branches(repo.dir)).toEqual(['pr-split/01-database', 'pr-split/02-api']);
  });
});

describe('--execute: branches that already exist', () => {
  it('refuses to overwrite a pr-split/* branch that pr-split did not make for this feature', async () => {
    repo = makeSplitRepo({ validate: { test: 'true' } });
    git(repo.dir, 'branch', 'pr-split/01-database', 'main');
    const mine = git(repo.dir, 'rev-parse', 'pr-split/01-database');
    const { code, stderr } = await run(repo, ['--execute']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/pr-split\/01-database already exists/);
    expect(stderr).toMatch(/--force/);
    expect(git(repo.dir, 'rev-parse', 'pr-split/01-database')).toBe(mine);
    expect(branches(repo.dir)).toEqual(['pr-split/01-database']);
  });

  it('refuses a branch pr-split made for a different feature, and --force overwrites it', async () => {
    repo = makeSplitRepo({ validate: { test: 'true' } });
    expect((await run(repo, ['--execute'])).code).toBe(0);
    git(repo.dir, 'checkout', '-q', '-b', 'feature/other', 'main');
    writeFiles(repo.dir, { 'db/other.sql': 'SELECT 1;\n', 'src/api/other.js': 'export {};\n' });
    commitAll(repo.dir, 'other feature');
    const refused = await run(repo, ['--execute']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/pr-split\/01-database already exists/);
    const forced = await run(repo, ['--execute', '--force']);
    expect(forced.code, forced.stderr).toBe(0);
    expect(git(repo.dir, 'diff', '--name-only', 'main', 'pr-split/01-database')).toBe('db/other.sql');
  });

  it('refuses when someone added commits on top of a pr-split branch', async () => {
    repo = makeSplitRepo({ validate: { test: 'true' } });
    expect((await run(repo, ['--execute'])).code).toBe(0);
    git(repo.dir, 'checkout', '-q', 'pr-split/02-api');
    writeFiles(repo.dir, { 'src/api/review-fix.js': 'export {};\n' });
    commitAll(repo.dir, 'fix from review');
    git(repo.dir, 'checkout', '-q', repo.featureBranch);
    const { code, stderr } = await run(repo, ['--execute']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/pr-split\/02-api already exists/);
    expect(message(repo, 'pr-split/02-api')).toMatch(/fix from review/);
  });

  it('refreshes its own stack on a re-run without --force', async () => {
    repo = makeSplitRepo({ validate: { test: 'true' } });
    expect((await run(repo, ['--execute'])).code).toBe(0);
    writeFiles(repo.dir, { 'src/api/users.js': 'export const users = ["v2"];\n' });
    commitAll(repo.dir, 'second feature commit');
    const { code, stderr } = await run(repo, ['--execute']);
    expect(code, stderr).toBe(0);
    expect(git(repo.dir, 'show', 'pr-split/02-api:src/api/users.js')).toContain('v2');
  });
});

describe('conventional commit messages with an issue reference', () => {
  it('commits each layer as type(scope): subject, with a Refs trailer for --issue', async () => {
    repo = makeSplitRepo({ validate: { test: 'true' } });
    const { code, stderr } = await run(repo, ['--execute', '--issue', '123']);
    expect(code, stderr).toBe(0);
    const db = message(repo, 'pr-split/01-database');
    const api = message(repo, 'pr-split/02-api');
    expect(db.split('\n')[0]).toBe('feat(database): schema, migrations and data models');
    expect(api.split('\n')[0]).toBe('feat(api): API routes, handlers and server code');
    expect(db).toContain('Part 1/2 of feature/split-me, split by pr-split.');
    for (const text of [db, api]) {
      expect(text.split('\n')[0]).toMatch(CONVENTIONAL);
      const trailers = spawnSync('git', ['interpret-trailers', '--parse'], { input: text, encoding: 'utf8' }).stdout;
      expect(trailers.trim()).toBe('Refs: #123');
    }
  });

  it('leaves the trailer out when no issue is given', async () => {
    repo = makeSplitRepo({ validate: { test: 'true' } });
    expect((await run(repo, ['--execute'])).code).toBe(0);
    expect(message(repo, 'pr-split/01-database')).not.toMatch(/Refs:/);
  });

  it.each([
    ['123', '#123'],
    ['#7', '#7'],
    ['ABC-42', 'ABC-42'],
    ['octo/repo#9', 'octo/repo#9'],
    ['https://github.com/octo/repo/issues/9', 'https://github.com/octo/repo/issues/9'],
  ])('accepts --issue %s as "Refs: %s"', async (input, ref) => {
    repo = makeSplitRepo();
    const { code, stdout } = await run(repo, ['--json', '--issue', input]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).issue).toBe(ref);
    expect(readFileSync(join(repo.dir, 'pr-split.sh'), 'utf8')).toContain(`-m ${quote(`Refs: ${ref}`)}`);
  });

  it.each([['line\nbreak'], [''], ['  '], ['-x'], ['x'.repeat(201)]])('rejects --issue %j with exit 2', async (value) => {
    repo = makeSplitRepo();
    const { code, stderr } = await run(repo, [`--issue=${value}`]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--issue/);
  });

  describe('commitMessage', () => {
    const base = { index: 1, count: 3, feature: 'feature/x', issue: null };
    it.each([
      ['docs', 'docs'],
      ['tests', 'test'],
      ['config', 'chore'],
      ['ci', 'ci'],
      ['database', 'feat'],
      ['payments', 'feat'],
    ])('maps group "%s" to type "%s"', (name, type) => {
      expect(commitMessage({ ...base, name, description: 'Something' }).subject).toBe(`${type}(${name}): something`);
    });

    it('keeps acronyms, falls back to a generic subject, and caps the header at 100 characters', () => {
      expect(commitMessage({ ...base, name: 'api', description: 'API routes' }).subject).toBe('feat(api): API routes');
      expect(commitMessage({ ...base, name: 'api', description: '' }).subject).toBe('feat(api): part 1 of feature/x');
      const long = commitMessage({ ...base, name: 'api', description: 'word '.repeat(40).trim() });
      expect(long.subject.length).toBeLessThanOrEqual(100);
      expect(long.subject).toMatch(/word$/);
    });

    it('puts the issue in a trailer paragraph of its own', () => {
      const { body, trailers } = commitMessage({ ...base, name: 'api', description: 'x', issue: 'ABC-1' });
      expect(body).toBe('Part 1/3 of feature/x, split by pr-split.');
      expect(trailers).toEqual(['Refs: ABC-1']);
    });
  });
});

describe('--push', () => {
  it('pushes every branch to origin after all layers pass, and sets upstreams', async () => {
    repo = makeSplitRepo({ validate: { test: 'true' } });
    remote = addBareRemote(repo);
    const { code, stderr } = await run(repo, ['--execute', '--push']);
    expect(code, stderr).toBe(0);
    expect(branches(remote.dir)).toEqual(['pr-split/01-database', 'pr-split/02-api']);
    for (const branch of ['pr-split/01-database', 'pr-split/02-api']) {
      expect(git(remote.dir, 'rev-parse', branch)).toBe(git(repo.dir, 'rev-parse', branch));
      expect(git(repo.dir, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`)).toBe(`origin/${branch}`);
    }
    expect(stderr).toMatch(/pushed 2 branches to origin/);
  });

  it('pushes to --remote, and a re-run updates the pushed branches', async () => {
    repo = makeSplitRepo({ validate: { test: 'true' } });
    remote = addBareRemote(repo, 'upstream');
    expect((await run(repo, ['--execute', '--push', '--remote', 'upstream'])).code).toBe(0);
    writeFiles(repo.dir, { 'src/api/users.js': 'export const users = ["v2"];\n' });
    commitAll(repo.dir, 'second feature commit');
    const { code, stderr } = await run(repo, ['--execute', '--push', '--remote', 'upstream']);
    expect(code, stderr).toBe(0);
    expect(git(remote.dir, 'rev-parse', 'pr-split/02-api')).toBe(git(repo.dir, 'rev-parse', 'pr-split/02-api'));
    expect(git(remote.dir, 'show', 'pr-split/02-api:src/api/users.js')).toContain('v2');
  });

  it('pushes nothing when a layer fails validation', async () => {
    repo = makeSplitRepo({ validate: { check: 'test "$(git branch --show-current)" != pr-split/02-api' } });
    remote = addBareRemote(repo);
    const { code } = await run(repo, ['--execute', '--push']);
    expect(code).toBe(1);
    expect(branches(remote.dir)).toEqual([]);
  });

  it('fails with exit 2 before changing anything when the remote does not exist', async () => {
    repo = makeSplitRepo({ validate: { test: 'true' } });
    const { code, stderr } = await run(repo, ['--execute', '--push']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/no git remote named "origin"/);
    expect(branches(repo.dir)).toEqual([]);
  });

  it('shows the push in a dry run without pushing', async () => {
    repo = makeSplitRepo();
    remote = addBareRemote(repo);
    const { code, stdout } = await run(repo, ['--push']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Push: to origin once every layer has passed/);
    const dry = spawnSync('bash', [join(repo.dir, 'pr-split.sh')], { cwd: repo.dir, encoding: 'utf8', env: scriptEnv() });
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('+ git push --force-with-lease -u origin pr-split/01-database pr-split/02-api');
    expect(branches(remote.dir)).toEqual([]);
    expect(branches(repo.dir)).toEqual([]);
  });

  it.each([[['--remote', 'origin']], [['--push', '--remote=-x']], [['--push', '--remote=a b']]])('rejects %j with exit 2', async (args) => {
    repo = makeSplitRepo();
    const { code, stderr } = await run(repo, args);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--remote/);
  });
});

describe('--execute flag handling', () => {
  it('--help lists the M2 flags', async () => {
    const stdout = capture();
    expect(await main(['--help'], { env: {}, stdout, stderr: capture() })).toBe(0);
    for (const flag of ['--execute', '--push', '--remote', '--retries', '--issue', '--force']) {
      expect(stdout.text).toContain(flag);
    }
  });

  it('cannot be combined with --dry-run', async () => {
    repo = makeSplitRepo();
    const { code, stderr } = await run(repo, ['--execute', '--dry-run']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--execute.*--dry-run/);
    expect(branches(repo.dir)).toEqual([]);
  });

  it('says in the summary that the script is being run', async () => {
    repo = makeSplitRepo({ validate: { test: 'true' } });
    const { code, stdout } = await run(repo, ['--execute']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Running pr-split\.sh now \(--execute\)/);
    expect(stdout).not.toMatch(/Dry-run script/);
  });
});
