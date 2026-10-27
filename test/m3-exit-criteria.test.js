// ROADMAP.md M3 exit criteria: `pr-split --execute --pr` opens the stack as pull requests, one
// describe block each. "GitHub" is the fake gh from fake-gh.mjs, first on PATH; it only accepts a
// PR whose branches are on the test's bare remote, and numbers PRs from 11.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BIN,
  STACK_LAYERS,
  addBareRemote,
  branches,
  commitAll,
  fakeGitHub,
  git,
  makeStackRepo,
  openPrs,
  scriptEnv,
  writeFiles,
} from './helpers.js';

const BRANCHES = ['pr-split/01-database', 'pr-split/02-api', 'pr-split/03-ui'];
const NUMBERS = [11, 12, 13];
const STACK_MAP = '<!-- pr-split:stack-map -->';
const quote = (path) => `'${path.replaceAll("'", "'\\''")}'`;
const section = (body, heading) => {
  const start = body.indexOf(`## ${heading}`);
  expect(start, heading).toBeGreaterThan(-1);
  const next = body.indexOf('\n## ', start + 1);
  return body.slice(start, next === -1 ? undefined : next);
};

/** A repo with the three-layer project, a bare `origin` holding main, and a fake GitHub. */
function setup(config) {
  const repo = makeStackRepo(config);
  const remote = addBareRemote(repo);
  git(repo.dir, 'push', '-q', 'origin', 'main');
  const github = fakeGitHub();
  return {
    repo,
    remote,
    github,
    cleanup() {
      repo.cleanup();
      remote.cleanup();
      github.cleanup();
    },
  };
}

/** The real bin, the way a CI job runs it: no TTY, no stdin, a bare environment with CI=true. */
function runInCi({ repo, github }, args) {
  const result = spawnSync(process.execPath, [BIN, '--base', 'main', '--no-llm', ...args], {
    cwd: repo.dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: scriptEnv({ CI: 'true', GITHUB_ACTIONS: 'true', ...github.env }),
  });
  return { ...result, json: args.includes('--json') && result.stdout ? JSON.parse(result.stdout) : null };
}

describe('M3 exit criteria: pr-split --execute --pr opens the stack on GitHub', () => {
  let markers;
  let env;
  let result;
  let prs;
  beforeAll(() => {
    markers = mkdtempSync(join(tmpdir(), 'pr-split-markers-'));
    env = setup({
      validate: {
        build: 'node scripts/check.mjs',
        test: `echo "test $(git branch --show-current)" >> ${quote(join(markers, 'validate.log'))}`,
      },
    });
    result = runInCi(env, ['--execute', '--pr', '--json']);
    prs = openPrs(env.github);
  });
  afterAll(() => {
    env.cleanup();
    rmSync(markers, { recursive: true, force: true });
  });

  describe('EC1: after --execute --pr, exactly N PRs are opened on GitHub', () => {
    it('exits 0 and reports one opened PR per layer (N = 3)', () => {
      expect(result.status, result.stderr).toBe(0);
      expect(result.json.execution).toEqual({ ok: true, exitCode: 0 });
      expect(result.json.pullRequests.map(({ number, branch, action }) => ({ number, branch, action }))).toEqual(
        BRANCHES.map((branch, i) => ({ number: NUMBERS[i], branch, action: 'opened' })),
      );
      expect(result.json.pullRequests.map((pr) => pr.url)).toEqual(NUMBERS.map((n) => `https://github.com/acme/shop/pull/${n}`));
    });

    it('GitHub holds exactly 3 open PRs, one per layer branch, each pushed at the local commit', () => {
      expect(prs).toHaveLength(3);
      expect(prs.map((pr) => pr.headRefName)).toEqual(BRANCHES);
      expect(branches(env.remote.dir)).toEqual(BRANCHES);
      for (const branch of BRANCHES) {
        expect(git(env.remote.dir, 'rev-parse', branch), branch).toBe(git(env.repo.dir, 'rev-parse', branch));
      }
    });

    it('a re-run after another feature commit still has exactly 3 PRs: they are updated, not duplicated', () => {
      const again = setup({ validate: { build: 'node scripts/check.mjs' } });
      try {
        expect(runInCi(again, ['--execute', '--pr']).status).toBe(0);
        writeFiles(again.repo.dir, {
          'src/api/users.js': `${STACK_LAYERS.api['src/api/users.js']}export const countUsers = () => listUsers().length;\n`,
        });
        commitAll(again.repo.dir, 'count users');
        const rerun = runInCi(again, ['--execute', '--pr', '--json']);
        expect(rerun.status, rerun.stderr).toBe(0);
        const after = openPrs(again.github);
        expect(after.map((pr) => [pr.number, pr.headRefName])).toEqual(BRANCHES.map((b, i) => [NUMBERS[i], b]));
        expect(rerun.json.pullRequests.find((pr) => pr.branch === 'pr-split/02-api').action).toBe('updated');
        expect(after[1].body).toContain('+4 -0'); // src/api/users.js grew by one line
        expect(again.github.commands().filter((c) => c === 'pr create')).toHaveLength(3);
      } finally {
        again.cleanup();
      }
    });
  });

  describe('EC2: PRs are stacked: PR #2 lists a dependency on PR #1, PR #3 on PR #2', () => {
    it('each PR targets the branch of the PR below it, and the bottom one targets main', () => {
      expect(prs.map((pr) => [pr.headRefName, pr.baseRefName])).toEqual([
        ['pr-split/01-database', 'main'],
        ['pr-split/02-api', 'pr-split/01-database'],
        ['pr-split/03-ui', 'pr-split/02-api'],
      ]);
    });

    it('opened them in dependency order, bottom-up', () => {
      const created = env.github
        .state()
        .calls.filter((call) => call.command === 'pr create')
        .map((call) => call.args[call.args.indexOf('--head') + 1]);
      expect(created).toEqual(BRANCHES);
    });

    it('each body has a Dependencies section naming the PR below it (and everything under that)', () => {
      const [first, second, third] = prs.map((pr) => section(pr.body, 'Dependencies'));
      expect(first).toMatch(/None: this is the bottom of the stack/);
      expect(first).not.toMatch(/Depends on/);
      expect(second).toContain('Depends on #11.');
      expect(second).not.toMatch(/#13/);
      expect(third).toContain('Depends on #12.');
      expect(third).toMatch(/1\. #11 \*\*database\*\*[^\n]*\n2\. #12 \*\*api\*\*/);
    });

    it('links the three PRs as a native GitHub stack, bottom to top', () => {
      expect(env.github.state().stacks).toEqual([{ number: 1, pull_requests: NUMBERS }]);
      expect(result.json.nativeStack).toMatchObject({ linked: true, created: true, number: 1 });
    });

    it('posts one stack-map comment on every PR, listing the whole stack and marking that PR', () => {
      expect(prs).toHaveLength(3);
      for (const [i, pr] of prs.entries()) {
        const maps = pr.comments.filter((c) => c.body.startsWith(STACK_MAP));
        expect(maps, `#${pr.number}`).toHaveLength(1);
        const rows = maps[0].body.split('\n').filter((line) => /^\| \d \|/.test(line));
        expect(rows.map((row) => row.match(/#\d+/)[0])).toEqual(['#13', '#12', '#11']); // top of the stack first
        expect(rows.filter((row) => row.includes('this PR'))).toEqual([rows[2 - i]]);
      }
    });
  });

  describe('EC3: each PR passes CI checks (as validated in M2)', () => {
    it('every layer passed validation before the first PR was opened', () => {
      const firstOpened = result.stderr.indexOf('pr-split: opened #11');
      expect(firstOpened).toBeGreaterThan(-1);
      for (const branch of BRANCHES) {
        const passed = result.stderr.indexOf(`pr-split: ${branch} passed validation (build, test)`);
        expect(passed, branch).toBeGreaterThan(-1);
        expect(passed, branch).toBeLessThan(firstOpened);
      }
      expect(readFileSync(join(markers, 'validate.log'), 'utf8').trim().split('\n')).toEqual(BRANCHES.map((b) => `test ${b}`));
    });

    it('each body names the checks that passed on exactly the commit the PR shows', () => {
      expect(prs).toHaveLength(3);
      for (const pr of prs) {
        const head = git(env.remote.dir, 'rev-parse', pr.headRefName);
        const validation = section(pr.body, 'Validation');
        expect(validation).toContain(`<!-- pr-split:validated ${head} build,test -->`);
        expect(validation).toContain(`✅ This commit (\`${head.slice(0, 7)}\`) passed **build**, **test**`);
      }
    });

    it('the native stack is what makes GitHub run the checks of main on every PR, and the stack map says so', () => {
      expect(prs).toHaveLength(3);
      for (const pr of prs) {
        expect(pr.stack, `#${pr.number}`).toMatchObject({ number: 1, size: 3 });
        expect(pr.comments[0].body).toMatch(/Linked as a native GitHub stack.*checks of `main` on every PR/s);
      }
    });

    it('a layer that fails validation opens no PR and pushes nothing', () => {
      const failing = setup({ validate: { check: 'test "$(git branch --show-current)" != pr-split/03-ui' } });
      try {
        const run = runInCi(failing, ['--execute', '--pr']);
        expect(run.status).toBe(1);
        expect(run.stderr).toMatch(/FAILED on pr-split\/03-ui/);
        expect(failing.github.commands()).toEqual(['auth status']);
        expect(openPrs(failing.github)).toEqual([]);
        expect(branches(failing.remote.dir)).toEqual([]);
      } finally {
        failing.cleanup();
      }
    });
  });

  describe('EC4: the PR body contains a generated summary of changes per group', () => {
    it("each body's Summary names the group, describes it and lists exactly its files with line counts", () => {
      const descriptions = {
        database: 'Schema, migrations and data models',
        api: 'API routes, handlers and server code',
        ui: 'User interface: components, pages and styles',
      };
      const parents = ['main', ...BRANCHES.slice(0, -1)];
      for (const [i, group] of ['database', 'api', 'ui'].entries()) {
        const body = prs[i].body;
        const summary = section(body, 'Summary');
        expect(summary).toContain(`**${group}**: ${descriptions[group]}`);
        expect(summary).toContain(`Part ${i + 1} of 3 of \`feature/split-me\``);
        const numstat = git(env.repo.dir, 'diff', '--numstat', parents[i], BRANCHES[i]).split('\n');
        expect(numstat).toHaveLength(Object.keys(STACK_LAYERS[group]).length);
        for (const line of numstat) {
          const [added, deleted, path] = line.split('\t');
          expect(summary, path).toContain(`| added | \`${path}\` | +${added} -${deleted} |`);
        }
        for (const [other, files] of Object.entries(STACK_LAYERS)) {
          if (other === group) continue;
          for (const path of Object.keys(files)) expect(body, `${group} lists ${path}`).not.toContain(path);
        }
      }
    });

    it('the title is the layer\'s conventional commit subject', () => {
      expect(prs.map((pr) => pr.title)).toEqual([
        'feat(database): schema, migrations and data models',
        'feat(api): API routes, handlers and server code',
        'feat(ui): user interface: components, pages and styles',
      ]);
    });
  });
});
