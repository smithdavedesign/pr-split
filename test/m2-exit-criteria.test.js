// ROADMAP.md M2 exit criteria: `pr-split --execute` builds the stack for real, one describe block each.
// The fixture is a small ESM project whose layers import each other (database ← api ← ui), and
// `scripts/check.mjs` loads every module, so a layer only passes validation if it builds on its own.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import {
  BIN,
  STACK_LAYERS,
  branches,
  capture,
  commitAll,
  git,
  makeStackRepo,
  scriptEnv,
  startFakeOllama,
  writeFiles,
} from './helpers.js';

const LAYERS = ['database', 'api', 'ui'];
const BRANCHES = ['pr-split/01-database', 'pr-split/02-api', 'pr-split/03-ui'];
const sorted = (list) => [...list].sort();
const lines = (text) => (text === '' ? [] : text.split('\n'));
const quote = (path) => `'${path.replaceAll("'", "'\\''")}'`;

/** Runs the real bin the way a CI job would: no TTY, no stdin, a bare environment with CI=true. */
function runInCi(repo, args) {
  return spawnSync(process.execPath, [BIN, '--base', 'main', ...args], {
    cwd: repo.dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: scriptEnv({ CI: 'true', GITHUB_ACTIONS: 'true' }),
  });
}

/** Runs `command` in a separate worktree of `branch`, so the main checkout is untouched. */
function inWorktree(repo, branch, command) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-split-worktree-'));
  rmSync(dir, { recursive: true });
  git(repo.dir, 'worktree', 'add', '-q', '--detach', dir, branch);
  try {
    return spawnSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8', env: scriptEnv() });
  } finally {
    git(repo.dir, 'worktree', 'remove', '--force', dir);
  }
}

describe('M2 exit criteria: pr-split --execute on a test feature branch in CI', () => {
  let markers;
  let log;
  let repo;
  let result;
  let plan;
  beforeAll(() => {
    markers = mkdtempSync(join(tmpdir(), 'pr-split-markers-'));
    log = join(markers, 'validate.log');
    repo = makeStackRepo({
      validate: {
        // Also leaves an untracked build output behind, which must never end up in a branch.
        build: 'node scripts/check.mjs && mkdir -p dist && echo built > dist/out.txt',
        test: `echo "test $(git branch --show-current)" >> ${quote(log)}`,
      },
    });
    result = runInCi(repo, ['--execute', '--no-llm', '--json']);
    plan = JSON.parse(result.stdout);
  });
  afterAll(() => {
    repo.cleanup();
    rmSync(markers, { recursive: true, force: true });
  });

  describe('EC1: running the tool with --execute creates N branches', () => {
    it('exits 0 and reports a successful execution', () => {
      expect(result.status, result.stderr).toBe(0);
      expect(plan.execution).toEqual({ ok: true, exitCode: 0 });
    });

    it('creates exactly one branch per planned group (N = 3), and no leftovers', () => {
      expect(plan.groups.map((g) => g.name)).toEqual(LAYERS);
      expect(plan.groups.map((g) => g.branch)).toEqual(BRANCHES);
      expect(branches(repo.dir)).toEqual(BRANCHES);
      expect(result.stderr).toMatch(/created 3 branches/);
    });

    it('leaves the repo on the feature branch with a clean tree', () => {
      expect(git(repo.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(repo.featureBranch);
      expect(git(repo.dir, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    });
  });

  describe('EC2: each branch passes the validation script (exit code 0)', () => {
    it('ran the configured validation on every branch, bottom-up, and each one passed', () => {
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(BRANCHES.map((b) => `test ${b}`));
      for (const branch of BRANCHES) expect(result.stderr).toContain(`${branch} passed validation`);
    });

    it('each branch on its own still exits 0 when the validation commands run on it again', () => {
      for (const branch of BRANCHES) {
        const check = inWorktree(repo, branch, 'node scripts/check.mjs');
        expect(check.status, `${branch}: ${check.stderr}`).toBe(0);
      }
    });

    it('a layer that does not build fails validation: the run stops there and names the branch', async () => {
      // The model puts the API layer first, so it imports database code that isn't there yet.
      const wrong = makeStackRepo({ validate: { build: 'node scripts/check.mjs' } });
      const ollama = await startFakeOllama(() => ({
        groups: [
          { name: 'api', description: 'Endpoints', files: Object.keys(STACK_LAYERS.api) },
          { name: 'database', description: 'Data layer', files: Object.keys(STACK_LAYERS.database) },
          { name: 'ui', description: 'Screens', files: Object.keys(STACK_LAYERS.ui) },
        ],
      }));
      try {
        const stdout = capture();
        const stderr = capture();
        const code = await main(['--base', 'main', '--execute', '--json'], {
          cwd: wrong.dir,
          env: scriptEnv({ OLLAMA_HOST: ollama.host }),
          stdout,
          stderr,
        });
        expect(code).toBe(1);
        expect(JSON.parse(stdout.text).execution).toEqual({ ok: false, exitCode: 1 });
        expect(stderr.text).toMatch(/FAILED on pr-split\/01-api: validation "build" failed/);
        expect(stderr.text).toContain('ERR_MODULE_NOT_FOUND');
        expect(branches(wrong.dir)).toEqual(['pr-split/01-api']);
        expect(git(wrong.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(wrong.featureBranch);
      } finally {
        await ollama.close();
        wrong.cleanup();
      }
    });
  });

  describe('EC3: branches are based on the previous layer (git merge-base)', () => {
    it('layer 1 is based on main, and every other layer on the layer before it', () => {
      const sha = (ref) => git(repo.dir, 'rev-parse', ref);
      const parents = ['main', ...BRANCHES.slice(0, -1)];
      expect(plan.groups.map((g) => g.parent)).toEqual(parents);
      BRANCHES.forEach((branch, i) => {
        expect(git(repo.dir, 'merge-base', branch, parents[i]), branch).toBe(sha(parents[i]));
        expect(git(repo.dir, 'rev-list', '--count', `${parents[i]}..${branch}`), branch).toBe('1');
      });
    });

    it('stacks on the current tip of main when main moved after the feature branched', async () => {
      const moved = makeStackRepo({ validate: { build: 'node scripts/check.mjs' } });
      try {
        git(moved.dir, 'checkout', '-q', 'main');
        writeFiles(moved.dir, { 'CHANGELOG.md': 'upstream work\n' });
        commitAll(moved.dir, 'upstream change');
        git(moved.dir, 'checkout', '-q', moved.featureBranch);
        const stderr = capture();
        const code = await main(['--base', 'main', '--execute', '--no-llm'], {
          cwd: moved.dir,
          env: scriptEnv(),
          stdout: capture(),
          stderr,
        });
        expect(code, stderr.text).toBe(0);
        const mainTip = git(moved.dir, 'rev-parse', 'main');
        expect(git(moved.dir, 'merge-base', 'pr-split/01-database', 'main')).toBe(mainTip);
        expect(git(moved.dir, 'merge-base', 'pr-split/02-api', 'pr-split/01-database')).toBe(
          git(moved.dir, 'rev-parse', 'pr-split/01-database'),
        );
        expect(git(moved.dir, 'merge-base', 'pr-split/03-ui', 'pr-split/02-api')).toBe(
          git(moved.dir, 'rev-parse', 'pr-split/02-api'),
        );
      } finally {
        moved.cleanup();
      }
    });
  });

  describe('EC4: no files outside the selected groups are present in each branch', () => {
    it('each branch adds exactly its own group\'s files on top of its parent', () => {
      for (const group of plan.groups) {
        const changed = lines(git(repo.dir, 'diff', '--name-only', group.parent, group.branch));
        expect(sorted(changed), group.branch).toEqual(sorted(group.files.map((f) => f.path)));
      }
    });

    it('each branch holds main plus the files of its own and earlier layers, nothing else', () => {
      const tree = (ref) => sorted(lines(git(repo.dir, 'ls-tree', '-r', '--name-only', ref)));
      const expected = tree('main');
      for (const group of plan.groups) {
        expected.push(...group.files.map((f) => f.path));
        expect(tree(group.branch), group.branch).toEqual(sorted(expected));
      }
      expect(git(repo.dir, 'rev-parse', `${BRANCHES.at(-1)}^{tree}`)).toBe(
        git(repo.dir, 'rev-parse', `${repo.featureBranch}^{tree}`),
      );
    });

    it('untracked files around during the run (the script, build output) are in no branch', () => {
      expect(existsSync(join(repo.dir, 'dist/out.txt'))).toBe(true);
      expect(existsSync(join(repo.dir, 'pr-split.sh'))).toBe(true);
      for (const branch of BRANCHES) {
        const files = lines(git(repo.dir, 'ls-tree', '-r', '--name-only', branch));
        expect(files, branch).not.toContain('dist/out.txt');
        expect(files, branch).not.toContain('pr-split.sh');
      }
    });
  });
});
