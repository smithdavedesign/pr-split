// M3 deliverables beyond the exit criteria: --pr-only, re-runs that update PRs, existing PRs,
// failures, flags, and the PR text itself. "GitHub" is the fake gh from fake-gh.mjs.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { assertGh, gh } from '../src/github.js';
import {
  BODY_END,
  BODY_START,
  MAX_BODY_FILES,
  STACK_MAP_MARKER,
  codeSpan,
  linkStack,
  mdText,
  mergeBody,
  prSection,
  stackMap,
  validatedChecks,
} from '../src/pr.js';
import {
  STACK_LAYERS,
  addBareRemote,
  branches,
  capture,
  commitAll,
  fakeGitHub,
  git,
  makeStackRepo,
  openPrs,
  scriptEnv,
  startFakeOllama,
  writeFiles,
} from './helpers.js';

const BRANCHES = ['pr-split/01-database', 'pr-split/02-api', 'pr-split/03-ui'];
const MUTATING = /^(pr create|pr edit|api (POST|PATCH) )/;

let env;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

/** The three-layer project with a bare `origin` (holding main) and a fake GitHub. */
function setup(config = { validate: { build: 'node scripts/check.mjs' } }, github = {}) {
  const repo = makeStackRepo(config);
  const remote = addBareRemote(repo);
  git(repo.dir, 'push', '-q', 'origin', 'main');
  const gh = fakeGitHub(github);
  env = {
    repo,
    remote,
    github: gh,
    cleanup() {
      repo.cleanup();
      remote.cleanup();
      gh.cleanup();
    },
  };
  return env;
}

async function run(args, { base = 'main', extraEnv = {} } = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(['--base', base, '--no-llm', ...args], {
    cwd: env.repo.dir,
    env: scriptEnv({ ...env.github.env, ...extraEnv }),
    stdout,
    stderr,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

const changeApi = () => {
  writeFiles(env.repo.dir, {
    'src/api/users.js': `${STACK_LAYERS.api['src/api/users.js']}export const countUsers = () => listUsers().length;\n`,
  });
  commitAll(env.repo.dir, 'count users');
};
const commandsSince = (from) => env.github.commands().slice(from);
const stackMaps = (pr) => pr.comments.filter((c) => c.body.startsWith(STACK_MAP_MARKER));

describe('--pr-only: open PRs from branches that already exist', () => {
  it('pushes a stack that --execute built locally, then opens its PRs, marked as not validated by this run', async () => {
    setup();
    expect((await run(['--execute'])).code).toBe(0);
    expect(env.github.commands()).toEqual([]);
    expect(branches(env.remote.dir)).toEqual([]);

    const { code, stderr } = await run(['--pr-only']);
    expect(code, stderr).toBe(0);
    expect(branches(env.remote.dir)).toEqual(BRANCHES);
    const prs = openPrs(env.github);
    expect(prs.map((pr) => [pr.headRefName, pr.baseRefName])).toEqual([
      ['pr-split/01-database', 'main'],
      ['pr-split/02-api', 'pr-split/01-database'],
      ['pr-split/03-ui', 'pr-split/02-api'],
    ]);
    for (const pr of prs) {
      expect(pr.body).toMatch(/⚠️ Not validated by this pr-split run/);
      expect(pr.body).not.toContain('<!-- pr-split:validated');
    }
    expect(prs[1].body).toContain('Depends on #11.');
  });

  it('is a no-op right after --execute --pr: nothing is opened or edited, and "validated" stays', async () => {
    setup();
    expect((await run(['--execute', '--pr'])).code).toBe(0);
    const before = env.github.commands().length;
    const { code, stderr } = await run(['--pr-only', '--json']);
    expect(code, stderr).toBe(0);
    expect(commandsSince(before).filter((c) => MUTATING.test(c))).toEqual([]);
    expect(openPrs(env.github)).toHaveLength(3);
    for (const pr of openPrs(env.github)) expect(pr.body).toContain('✅ This commit');
    expect(stderr).toMatch(/#11 pr-split\/01-database is up to date/);
  });

  it('says so when pr-split has not built a stack for this feature yet', async () => {
    setup();
    const { code, stderr } = await run(['--pr-only']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/no stack that pr-split built for feature\/split-me.*pr-split --execute/);
    expect(env.github.commands().filter((c) => MUTATING.test(c))).toEqual([]);
  });

  it('refuses to guess between two stacks built for the same feature', async () => {
    setup({});
    const replies = [
      [
        { name: 'database', description: 'Data', files: Object.keys(STACK_LAYERS.database) },
        { name: 'api', description: 'Endpoints', files: Object.keys(STACK_LAYERS.api) },
        { name: 'ui', description: 'Screens', files: Object.keys(STACK_LAYERS.ui) },
      ],
      [
        { name: 'data', description: 'Data', files: Object.keys(STACK_LAYERS.database) },
        { name: 'web', description: 'Web', files: [...Object.keys(STACK_LAYERS.api), ...Object.keys(STACK_LAYERS.ui)] },
      ],
    ];
    const ollama = await startFakeOllama(() => ({ groups: replies.shift() }));
    try {
      for (let i = 0; i < 2; i++) {
        const stdout = capture();
        const stderr = capture();
        const code = await main(['--base', 'main', '--execute'], {
          cwd: env.repo.dir,
          env: scriptEnv({ ...env.github.env, OLLAMA_HOST: ollama.host }),
          stdout,
          stderr,
        });
        expect(code, stderr.text).toBe(0);
      }
    } finally {
      await ollama.close();
    }
    const { code, stderr } = await run(['--pr-only']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/found 2 stacks that pr-split built for feature\/split-me/);
    expect(stderr).toContain('pr-split/03-ui');
    expect(stderr).toContain('pr-split/02-web');
    expect(openPrs(env.github)).toEqual([]);
  });

  it('refuses a stack whose layer got a commit pr-split did not make', async () => {
    setup();
    expect((await run(['--execute'])).code).toBe(0);
    git(env.repo.dir, 'checkout', '-q', 'pr-split/01-database');
    writeFiles(env.repo.dir, { 'db/fix.sql': 'SELECT 1;\n' });
    commitAll(env.repo.dir, 'fix from review');
    git(env.repo.dir, 'checkout', '-q', env.repo.featureBranch);
    const { code, stderr } = await run(['--pr-only']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/don't form a complete stack.*pr-split --execute/);
    expect(openPrs(env.github)).toEqual([]);
  });

  it("never drops a commit someone pushed to a layer branch that was fetched but isn't in the local branch", async () => {
    setup();
    expect((await run(['--execute', '--push'])).code).toBe(0);
    const reviewer = mkdtempSync(join(tmpdir(), 'pr-split-reviewer-'));
    try {
      git(reviewer, 'clone', '-q', '--branch', 'pr-split/02-api', env.remote.dir, '.');
      git(reviewer, 'config', 'user.name', 'Reviewer');
      git(reviewer, 'config', 'user.email', 'reviewer@example.invalid');
      writeFiles(reviewer, { 'src/api/review-fix.js': 'export const fixed = true;\n' });
      commitAll(reviewer, 'fix from review');
      git(reviewer, 'push', '-q', 'origin', 'pr-split/02-api');
    } finally {
      rmSync(reviewer, { recursive: true, force: true });
    }
    git(env.repo.dir, 'fetch', '-q', 'origin');
    const reviewed = git(env.remote.dir, 'rev-parse', 'pr-split/02-api');

    const { code, stderr } = await run(['--pr-only']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/git push failed: .*\[rejected\].*pr-split\/02-api/);
    expect(git(env.remote.dir, 'rev-parse', 'pr-split/02-api')).toBe(reviewed);
    expect(openPrs(env.github)).toEqual([]);
  });

  it.each([[['--pr-only', '--execute']], [['--pr-only', '--dry-run']]])('rejects %j with exit 2', async (args) => {
    setup();
    const { code, stderr } = await run(args);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--pr-only/);
    expect(branches(env.repo.dir)).toEqual([]);
  });
});

describe('re-running pr-split updates the PRs instead of opening new ones', () => {
  it("keeps what people wrote outside pr-split's section and rewrites the section", async () => {
    setup();
    expect((await run(['--execute', '--pr'])).code).toBe(0);
    env.github.update((state) => {
      const pr = state.prs.find((p) => p.number === 12);
      pr.body = `Reviewer notes: start with users.js\r\n\r\n${pr.body.replaceAll('\n', '\r\n')}\r\n\r\nMore notes at the end`;
    });
    changeApi();
    const { code, stderr } = await run(['--execute', '--pr']);
    expect(code, stderr).toBe(0);
    const prs = openPrs(env.github);
    expect(prs).toHaveLength(3);
    const body = prs[1].body;
    expect(body.startsWith('Reviewer notes: start with users.js\r\n\r\n')).toBe(true);
    expect(body.endsWith('\r\n\r\nMore notes at the end')).toBe(true);
    expect(body.split(BODY_START)).toHaveLength(2);
    expect(body).toContain('| added | `src/api/users.js` | +4 -0 |');
    expect(body).not.toContain('| added | `src/api/users.js` | +3 -0 |');
  });

  it('sets a retargeted base back, and edits the stack-map comment instead of adding another', async () => {
    setup(undefined, { stacksUnsupported: true });
    expect((await run(['--execute', '--pr'])).code).toBe(0);
    env.github.update((state) => {
      state.prs.find((p) => p.number === 13).baseRefName = 'main';
    });
    changeApi();
    const before = env.github.commands().length;
    const { code, stderr } = await run(['--execute', '--pr']);
    expect(code, stderr).toBe(0);
    const prs = openPrs(env.github);
    expect(prs.map((pr) => pr.baseRefName)).toEqual(['main', 'pr-split/01-database', 'pr-split/02-api']);
    for (const pr of prs) expect(stackMaps(pr), `#${pr.number}`).toHaveLength(1);
    // The api layer now has users.js (4 lines) and routes/index.js (2 lines).
    expect(stackMaps(prs[1])[0].body).toMatch(/\| 2 \| \*\*#12 · this PR\*\* \| api \| 2 \| \+6 -0 \|/);
    expect(commandsSince(before)).toContain('api PATCH repos/{owner}/{repo}/issues/comments/9002');
    expect(commandsSince(before)).not.toContain('pr create');
  });

  it('does not link the native stack a second time', async () => {
    setup();
    expect((await run(['--execute', '--pr'])).code).toBe(0);
    const before = env.github.commands().length;
    const { code, stderr } = await run(['--execute', '--pr']);
    expect(code, stderr).toBe(0);
    expect(env.github.state().stacks).toHaveLength(1);
    expect(commandsSince(before)).not.toContain('api POST repos/{owner}/{repo}/stacks');
    expect(stderr).toMatch(/#11 #12 #13 are already GitHub stack 1/);
  });
});

describe('PRs that already exist for a branch', () => {
  it('adopts a PR someone opened by hand for a layer, keeping their description above the section', async () => {
    setup();
    expect((await run(['--execute', '--push'])).code).toBe(0);
    env.github.update((state) => {
      state.prs.push({
        number: 5,
        url: 'https://github.com/acme/shop/pull/5',
        title: 'API, opened by hand',
        body: 'Hand-written context for reviewers.',
        headRefName: 'pr-split/02-api',
        baseRefName: 'pr-split/01-database',
        state: 'OPEN',
        isCrossRepository: false,
        comments: [],
        stack: null,
      });
    });
    const { code, stderr } = await run(['--pr-only']);
    expect(code, stderr).toBe(0);
    const prs = openPrs(env.github);
    expect(prs.map((pr) => [pr.number, pr.headRefName])).toEqual([
      [5, 'pr-split/02-api'],
      [11, 'pr-split/01-database'],
      [12, 'pr-split/03-ui'],
    ]);
    const adopted = prs[0];
    expect(adopted.title).toBe('API, opened by hand');
    expect(adopted.body.startsWith(`Hand-written context for reviewers.\n\n${BODY_START}`)).toBe(true);
    expect(adopted.body).toContain('Depends on #11.');
    expect(prs[2].body).toContain('Depends on #5.');
  });

  it("ignores a fork's PR from a branch with the same name", async () => {
    setup();
    env.github.update((state) => {
      state.prs.push({
        number: 3,
        url: 'https://github.com/acme/shop/pull/3',
        title: 'Fork work',
        body: 'From a fork.',
        headRefName: 'pr-split/01-database',
        baseRefName: 'main',
        state: 'OPEN',
        isCrossRepository: true,
        comments: [],
        stack: null,
      });
    });
    const { code, stderr } = await run(['--execute', '--pr']);
    expect(code, stderr).toBe(0);
    const fork = env.github.state().prs.find((pr) => pr.number === 3);
    expect(fork.body).toBe('From a fork.');
    expect(fork.comments).toEqual([]);
    expect(openPrs(env.github).filter((pr) => !pr.isCrossRepository).map((pr) => pr.number)).toEqual([11, 12, 13]);
  });
});

describe('when opening the PRs fails', () => {
  it('names the branch and the PRs already opened, and --pr-only finishes the stack without duplicates', async () => {
    setup(undefined, { failOn: { 'pr create': 2 } });
    const failed = await run(['--execute', '--pr']);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/couldn't open the PR for pr-split\/02-api: .*HTTP 502/);
    expect(failed.stderr).toMatch(/opened so far: #11/);
    expect(failed.stderr).toMatch(/pr-split --pr-only/);
    expect(openPrs(env.github).map((pr) => pr.number)).toEqual([11]);

    const finished = await run(['--pr-only']);
    expect(finished.code, finished.stderr).toBe(0);
    expect(openPrs(env.github).map((pr) => [pr.number, pr.headRefName])).toEqual([
      [11, 'pr-split/01-database'],
      [12, 'pr-split/02-api'],
      [13, 'pr-split/03-ui'],
    ]);
  });

  it('names the PR it could not update on a re-run', async () => {
    setup(undefined, { failOn: { 'pr edit': 1 } });
    expect((await run(['--execute', '--pr'])).code).toBe(0);
    changeApi();
    const { code, stderr } = await run(['--execute', '--pr']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/couldn't update #1[123] for pr-split\/0\d-\w+: gh pr edit failed: HTTP 502/);
  });

  it('gives up on a gh call that hangs, with a clear reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-split-slowgh-'));
    try {
      writeFileSync(join(dir, 'gh'), '#!/bin/sh\nsleep 5\n');
      chmodSync(join(dir, 'gh'), 0o755);
      await expect(gh(['pr', 'list'], { cwd: dir, env: { PATH: `${dir}:${process.env.PATH}` }, timeoutMs: 200 })).rejects.toThrow(
        /gh pr list failed: no answer within 0\.2s/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a failure in --json output too', async () => {
    setup(undefined, { failOn: { 'pr create': 2 } });
    const { code, stdout } = await run(['--execute', '--pr', '--json']);
    expect(code).toBe(1);
    const out = JSON.parse(stdout);
    expect(out.execution).toEqual({ ok: true, exitCode: 0 });
    expect(out.pullRequests.map((pr) => pr.number)).toEqual([11]);
    expect(out.pullRequestError).toMatch(/pr-split\/02-api/);
  });

  it('stops before building anything when gh is not logged in', async () => {
    setup(undefined, { loggedOut: true });
    const { code, stderr } = await run(['--execute', '--pr']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/gh auth login/);
    expect(branches(env.repo.dir)).toEqual([]);
    expect(branches(env.remote.dir)).toEqual([]);
  });

  it('stops before building anything when gh is not installed', async () => {
    setup();
    const empty = mkdtempSync(join(tmpdir(), 'pr-split-nogh-'));
    try {
      const { code, stderr } = await run(['--execute', '--pr'], { extraEnv: { PATH: empty } });
      expect(code).toBe(2);
      expect(stderr).toMatch(/needs the GitHub CLI.*https:\/\/cli\.github\.com/);
      expect(branches(env.repo.dir)).toEqual([]);
      await expect(assertGh({ cwd: env.repo.dir, env: { PATH: empty } })).rejects.toMatchObject({ code: 'USAGE' });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it.each([['a commit', (dir) => git(dir, 'rev-parse', 'main')], ['a tag', (dir) => (git(dir, 'tag', 'v1', 'main'), 'v1')]])(
    'exits 2 when --base is %s, which a PR cannot target',
    async (_, ref) => {
      setup();
      const { code, stderr } = await run(['--pr'], { base: ref(env.repo.dir) });
      expect(code).toBe(2);
      expect(stderr).toMatch(/--pr needs --base to be a branch/);
    },
  );

  it('only warns when the PRs cannot be linked as a native stack, and the stack map says how to link them', async () => {
    setup(undefined, { stacksUnsupported: true });
    const { code, stdout, stderr } = await run(['--execute', '--pr', '--json']);
    expect(code, stderr).toBe(0);
    expect(stderr).toMatch(/warning: couldn't link #11 #12 #13 as a GitHub stack \(.*Not Found.*\)/);
    expect(JSON.parse(stdout).nativeStack).toMatchObject({ linked: false });
    expect(openPrs(env.github)).toHaveLength(3);
    for (const pr of openPrs(env.github)) {
      expect(stackMaps(pr)[0].body).toMatch(/Not linked as a native GitHub stack/);
      expect(stackMaps(pr)[0].body).toContain('gh stack link 11 12 13');
    }
  });
});

describe('--pr flags and output', () => {
  it('a dry run with --pr shows the PR step, writes a script that pushes, and calls no gh', async () => {
    setup();
    const { code, stdout } = await run(['--pr']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Push: to origin once every layer has passed/);
    expect(stdout).toMatch(/Pull requests: then opens or updates 3 stacked PRs on GitHub with gh/);
    expect(readFileSync(join(env.repo.dir, 'pr-split.sh'), 'utf8')).toContain(
      "run git push --force-with-lease -u 'origin' 'pr-split/01-database' 'pr-split/02-api' 'pr-split/03-ui'",
    );
    expect(env.github.commands()).toEqual([]);
    expect(branches(env.repo.dir)).toEqual([]);
  });

  it('--base origin/main opens the bottom PR against main', async () => {
    setup();
    git(env.repo.dir, 'fetch', '-q', 'origin');
    const { code, stderr } = await run(['--execute', '--pr'], { base: 'origin/main' });
    expect(code, stderr).toBe(0);
    expect(openPrs(env.github).map((pr) => pr.baseRefName)).toEqual(['main', 'pr-split/01-database', 'pr-split/02-api']);
  });

  it('pushes to --remote and opens the PRs there', async () => {
    setup();
    const upstream = addBareRemote(env.repo, 'upstream');
    try {
      git(env.repo.dir, 'push', '-q', 'upstream', 'main');
      const { code, stderr } = await run(['--execute', '--pr', '--remote', 'upstream'], {
        extraEnv: { FAKE_GH_REMOTE: 'upstream' },
      });
      expect(code, stderr).toBe(0);
      expect(branches(upstream.dir)).toEqual(BRANCHES);
      expect(branches(env.remote.dir)).toEqual([]);
      expect(openPrs(env.github)).toHaveLength(3);
    } finally {
      upstream.cleanup();
    }
  });

  it('--issue puts a Refs line in every PR body', async () => {
    setup();
    const { code } = await run(['--execute', '--pr', '--issue', '42']);
    expect(code).toBe(0);
    expect(openPrs(env.github)).toHaveLength(3);
    for (const pr of openPrs(env.github)) expect(pr.body).toContain('\nRefs: #42\n');
  });

  it('--help lists --pr and --pr-only', async () => {
    const stdout = capture();
    expect(await main(['--help'], { env: {}, stdout, stderr: capture() })).toBe(0);
    expect(stdout.text).toContain('--pr ');
    expect(stdout.text).toContain('--pr-only');
  });

  it('reports each step in order: layers, push, each PR, the stack link, the stack map', async () => {
    setup();
    const { code, stderr } = await run(['--execute', '--pr']);
    expect(code, stderr).toBe(0);
    expect(stderr.split('\n').filter((line) => line.startsWith('pr-split: '))).toEqual([
      'pr-split: pr-split/01-database passed validation (build)',
      'pr-split: pr-split/02-api passed validation (build)',
      'pr-split: pr-split/03-ui passed validation (build)',
      'pr-split: pushed 3 branches to origin',
      'pr-split: created 3 branches (each passed: build): pr-split/01-database pr-split/02-api pr-split/03-ui',
      'pr-split: opened #11 pr-split/01-database → main: https://github.com/acme/shop/pull/11',
      'pr-split: opened #12 pr-split/02-api → pr-split/01-database: https://github.com/acme/shop/pull/12',
      'pr-split: opened #13 pr-split/03-ui → pr-split/02-api: https://github.com/acme/shop/pull/13',
      'pr-split: linked #11 #12 #13 as GitHub stack 1',
      'pr-split: stack map posted on #11 #12 #13',
      'pr-split: 3 stacked PRs into main; review and merge them bottom-up: #11, #12, #13',
    ]);
  });
});

describe('PR text', () => {
  const file = (path, extra = {}) => ({ path, status: 'A', additions: 1, deletions: 0, binary: false, ...extra });
  const layer = (index, extra = {}) => ({
    index,
    name: ['database', 'api', 'ui'][index - 1],
    summary: 'Something',
    branch: BRANCHES[index - 1],
    parent: index === 1 ? 'main' : BRANCHES[index - 2],
    sha: String(index).repeat(40),
    files: [file(`src/f${index}.js`)],
    additions: 1,
    deletions: 0,
    refs: [],
    ...extra,
  });
  const LAYERS = [layer(1), layer(2), layer(3)];
  const context = { layers: LAYERS, numbers: [11, 12], feature: 'feature/x', base: 'main', checks: ['build'] };

  it('shows model text as plain text: no mentions, issue references, links or HTML', () => {
    const text = mdText('Fixes #12 for @octocat, see [here](https://example.com) <img src=x> *now*');
    expect(text).not.toMatch(/#12/);
    expect(text).not.toMatch(/@octocat/);
    expect(text).toContain('\\[here\\]');
    expect(text).toContain('\\<img src=x\\>');
    expect(text).toContain('\\*now\\*');
    expect(mdText('a\nb\u001b[31m')).toBe('a b \\[31m');
  });

  it('puts paths in code spans that survive backticks', () => {
    expect(codeSpan('src/a.js')).toBe('`src/a.js`');
    expect(codeSpan('a`b.js')).toBe('``a`b.js``');
    expect(codeSpan('`x`')).toBe('`` `x` ``');
  });

  it('lists at most MAX_BODY_FILES files, with renames, deletions and binary files spelled out', () => {
    const files = [
      file('new/name.js', { status: 'R', oldPath: 'old/name.js' }),
      file('gone.js', { status: 'D', additions: 0, deletions: 4 }),
      file('logo.png', { binary: true, additions: 0 }),
      file('a|b.js'),
      ...Array.from({ length: MAX_BODY_FILES + 1 }, (_, i) => file(`src/f${i}.js`)),
    ];
    const body = prSection(layer(1, { files }), context);
    const rows = body.split('\n').filter((line) => /^\| (added|modified|deleted|renamed|copied|type changed)/.test(line));
    expect(rows).toHaveLength(MAX_BODY_FILES);
    expect(rows[0]).toBe('| renamed from `old/name.js` | `new/name.js` | +1 -0 |');
    expect(rows[1]).toBe('| deleted | `gone.js` | +0 -4 |');
    expect(rows[2]).toBe('| added | `logo.png` | binary |');
    expect(rows[3]).toBe('| added | `a\\|b.js` | +1 -0 |');
    expect(body).toContain(`…and ${files.length - MAX_BODY_FILES} more files.`);
  });

  it('keeps the body under GitHub\'s 65,536 characters even with very long paths', () => {
    const files = Array.from({ length: 90 }, (_, i) => file(`${'deep/'.repeat(200)}f${i}.js`));
    const body = prSection(layer(1, { files }), context);
    expect(body.length).toBeLessThan(65_536);
    const rows = body.split('\n').filter((line) => line.startsWith('| added |'));
    expect(rows.length).toBeLessThan(90);
    expect(body).toContain(`…and ${90 - rows.length} more files.`);
  });

  it('says plainly when a layer was not validated, or had nothing to validate', () => {
    expect(prSection(layer(2), { ...context, checks: null })).toMatch(/⚠️ Not validated by this pr-split run/);
    expect(prSection(layer(2), { ...context, checks: [] })).toMatch(/No validation commands are configured/);
  });

  it('round-trips the validated checks through the hidden marker, tied to the commit', () => {
    const body = prSection(layer(2), { ...context, checks: ['build', 'lint, strict', 'a-->b'] });
    expect(validatedChecks(body, layer(2).sha)).toEqual(['build', 'lint, strict', 'a-->b']);
    expect(validatedChecks(body, 'f'.repeat(40))).toBeNull();
    expect(validatedChecks('no marker', layer(2).sha)).toBeNull();
    expect(validatedChecks(undefined, layer(2).sha)).toBeNull();
    // An old copy of the section pasted above pr-split's own doesn't hide the current record.
    const older = prSection(layer(2, { sha: 'e'.repeat(40) }), { ...context, checks: ['old'] });
    expect(validatedChecks(`${older}\n\n${body}`, layer(2).sha)).toEqual(['build', 'lint, strict', 'a-->b']);
  });

  it('replaces only its own section of a body, even when a file name contains its end marker', () => {
    const hostile = layer(1, { files: [file(`evil ${BODY_END} x.js`)] });
    const first = `Notes above\n\n${prSection(hostile, context)}\n\nNotes below`;
    const next = mergeBody(first, prSection(layer(1), context));
    expect(next.startsWith('Notes above\n\n')).toBe(true);
    expect(next.endsWith('\n\nNotes below')).toBe(true);
    expect(next).not.toContain('evil');
    expect(next.split(BODY_START)).toHaveLength(2);
    expect(mergeBody(undefined, 'S')).toBe('S');
    expect(mergeBody('', 'S')).toBe('S');
    expect(mergeBody('By hand.\n', 'S')).toBe('By hand.\n\nS');
  });

  it('draws the stack top-down, marks the current PR, and says how to link an unlinked stack', () => {
    const map = stackMap(LAYERS, {
      numbers: [11, 12, 13],
      current: 2,
      feature: 'feature/x',
      base: 'main',
      nativeStack: { linked: false, reason: 'HTTP 404' },
    });
    expect(map.startsWith(`${STACK_MAP_MARKER}\n`)).toBe(true);
    const rows = map.split('\n').filter((line) => line.startsWith('| '));
    expect(rows.slice(2)).toEqual([
      '| 3 | #13 | ui | 1 | +1 -0 |',
      '| 2 | **#12 · this PR** | api | 1 | +1 -0 |',
      '| 1 | #11 | database | 1 | +1 -0 |',
      '|  | `main` | base |  |  |',
    ]);
    expect(map).toContain('gh stack link 11 12 13');
  });

  it('shows layer names (from branch names) as plain text in the body and the stack map', () => {
    const odd = [layer(1, { name: 'x|@team' }), layer(2)];
    const map = stackMap(odd, { numbers: [11, 12], current: 2, feature: 'f', base: 'main', nativeStack: { linked: true } });
    const ZWSP = String.fromCharCode(0x200b); // after "@", so "@team" mentions nobody
    expect(map).toContain(`| 1 | #11 | x\\|@${ZWSP}team | 1 | +1 -0 |`);
    expect(prSection(odd[1], { ...context, layers: odd, numbers: [11] })).toContain(`#11 **x\\|@${ZWSP}team**`);
  });

  describe('linkStack', () => {
    const client = (stacks, create = async () => ({ number: 7 })) => {
      const calls = [];
      return {
        calls,
        stackOf: async (n) => stacks[n] ?? null,
        createStack: async (numbers) => {
          calls.push(numbers);
          return create(numbers);
        },
      };
    };

    it('creates the stack when none of the PRs is in one', async () => {
      const github = client({});
      expect(await linkStack([1, 2, 3], github)).toEqual({ linked: true, created: true, number: 7 });
      expect(github.calls).toEqual([[1, 2, 3]]);
    });

    it('leaves a stack alone when all the PRs are already in the same one', async () => {
      const same = { number: 4, size: 3 };
      const github = client({ 1: same, 2: same, 3: same });
      expect(await linkStack([1, 2, 3], github)).toEqual({ linked: true, created: false, number: 4 });
      expect(github.calls).toEqual([]);
    });

    it('does not touch a stack that only some of the PRs are in', async () => {
      const github = client({ 1: { number: 4 }, 2: { number: 4 } });
      const result = await linkStack([1, 2, 3], github);
      expect(result.linked).toBe(false);
      expect(result.reason).toMatch(/#1 #2 are in GitHub stack 4/);
      expect(github.calls).toEqual([]);
    });

    it('turns an API error into a reason, never an exception', async () => {
      const github = client({}, async () => {
        throw new Error('gh api failed: gh: Validation Failed (HTTP 422)');
      });
      expect(await linkStack([1, 2], github)).toEqual({ linked: false, reason: 'gh api failed: gh: Validation Failed (HTTP 422)' });
    });

    it('needs at least two PRs', async () => {
      const github = client({});
      expect(await linkStack([1], github)).toEqual({ linked: false, reason: 'a stack needs at least two PRs' });
      expect(github.calls).toEqual([]);
    });
  });
});
