import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertRemote, excludeLocally, getChanges, parseNameStatus, parseNumstat, repoRoot } from '../src/git.js';
import { commitAll, git, makeRepo, writeFiles } from './helpers.js';

const z = (...tokens) => tokens.join('\0') + '\0';

describe('parseNameStatus (git diff --name-status -z)', () => {
  it('parses added, modified, deleted, type-changed, renamed and copied entries', () => {
    const output = z('A', 'db/a.sql', 'M', 'src/api/x.js', 'D', 'old.txt', 'T', 'bin/tool', 'R087', 'src/old.js', 'src/new.js', 'C100', 'a.js', 'b.js');
    expect(parseNameStatus(output)).toEqual([
      { status: 'A', path: 'db/a.sql' },
      { status: 'M', path: 'src/api/x.js' },
      { status: 'D', path: 'old.txt' },
      { status: 'T', path: 'bin/tool' },
      { status: 'R', path: 'src/new.js', oldPath: 'src/old.js' },
      { status: 'C', path: 'b.js', oldPath: 'a.js' },
    ]);
  });

  it('keeps spaces, tabs, quotes and newlines in paths', () => {
    const output = z('A', 'my dir/it\'s "x".sql', 'M', 'tab\there.js', 'A', 'new\nline.md');
    expect(parseNameStatus(output).map((f) => f.path)).toEqual(['my dir/it\'s "x".sql', 'tab\there.js', 'new\nline.md']);
  });

  it('returns no files for empty output', () => {
    expect(parseNameStatus('')).toEqual([]);
  });
});

describe('parseNumstat (git diff --numstat -z)', () => {
  it('reads line counts, binary files and renames', () => {
    const output = '3\t1\tsrc/a.js\0' + '-\t-\timg/logo.png\0' + '5\t2\t\0src/old.js\0src/new.js\0';
    expect(parseNumstat(output)).toEqual(
      new Map([
        ['src/a.js', { additions: 3, deletions: 1, binary: false }],
        ['img/logo.png', { additions: 0, deletions: 0, binary: true }],
        ['src/new.js', { additions: 5, deletions: 2, binary: false }],
      ]),
    );
  });

  it('keeps tabs inside paths', () => {
    expect(parseNumstat('1\t0\ta\tb.js\0').get('a\tb.js')).toEqual({ additions: 1, deletions: 0, binary: false });
  });
});

describe('getChanges', () => {
  let repo;
  afterEach(() => repo?.cleanup());

  it('lists every changed file with status, rename source and line counts, sorted by path', async () => {
    repo = makeRepo({
      base: { 'src/old.js': 'line\n'.repeat(20), 'docs/gone.md': 'bye\n', 'src/api/x.js': 'a\n' },
      rename: [['src/old.js', 'src/db/new.js']],
      remove: ['docs/gone.md'],
      feature: {
        'db/new table.sql': 'CREATE TABLE t ();\n',
        'logo.png': Buffer.from([0, 1, 2, 3, 0, 255]),
        'src/api/x.js': 'a\nb\n',
      },
    });
    const changes = await getChanges({ cwd: repo.dir, base: 'main', feature: repo.featureBranch });
    expect(changes.featureSha).toBe(git(repo.dir, 'rev-parse', repo.featureBranch));
    expect(changes.mergeBase).toBe(git(repo.dir, 'rev-parse', 'main'));
    expect(changes.files).toEqual([
      { path: 'db/new table.sql', status: 'A', additions: 1, deletions: 0, binary: false },
      { path: 'docs/gone.md', status: 'D', additions: 0, deletions: 1, binary: false },
      { path: 'logo.png', status: 'A', additions: 0, deletions: 0, binary: true },
      { path: 'src/api/x.js', status: 'M', additions: 1, deletions: 0, binary: false },
      { path: 'src/db/new.js', status: 'R', oldPath: 'src/old.js', additions: 0, deletions: 0, binary: false },
    ]);
  });

  it('diffs against the merge base, so commits that landed on base later are left out', async () => {
    repo = makeRepo({ feature: { 'src/api/a.js': 'export {};\n' } });
    git(repo.dir, 'checkout', '-q', 'main');
    writeFiles(repo.dir, { 'src/ui/late.css': 'body {}\n' });
    commitAll(repo.dir, 'later on main');
    git(repo.dir, 'checkout', '-q', repo.featureBranch);

    const changes = await getChanges({ cwd: repo.dir, base: 'main', feature: repo.featureBranch });
    expect(changes.files.map((f) => f.path)).toEqual(['src/api/a.js']);
    expect(changes.mergeBase).toBe(git(repo.dir, 'merge-base', 'main', repo.featureBranch));
    expect(changes.mergeBase).not.toBe(git(repo.dir, 'rev-parse', 'main'));
  });

  it('returns no files when the feature has no changes against base', async () => {
    repo = makeRepo();
    const changes = await getChanges({ cwd: repo.dir, base: repo.featureBranch, feature: repo.featureBranch });
    expect(changes.files).toEqual([]);
  });

  it('names the ref it cannot find', async () => {
    repo = makeRepo({ feature: { 'a.js': '1\n' } });
    await expect(getChanges({ cwd: repo.dir, base: 'nope', feature: repo.featureBranch })).rejects.toThrow(
      /unknown base "nope"/,
    );
    await expect(getChanges({ cwd: repo.dir, base: 'main', feature: 'missing/branch' })).rejects.toThrow(
      /unknown feature "missing\/branch"/,
    );
  });

  it('refuses refs that git would read as options', async () => {
    repo = makeRepo({ feature: { 'a.js': '1\n' } });
    await expect(getChanges({ cwd: repo.dir, base: '--output=/tmp/x', feature: repo.featureBranch })).rejects.toMatchObject({
      code: 'USAGE',
    });
    await expect(getChanges({ cwd: repo.dir, base: 'main', feature: '-p' })).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('points at the shallow clone when CI fetched too little history to find the merge base', async () => {
    repo = makeRepo({ feature: { 'a.js': '1\n' } });
    const shallow = mkdtempSync(join(tmpdir(), 'pr-split-shallow-'));
    try {
      git(shallow, 'clone', '-q', '--depth', '1', '--no-single-branch', `file://${repo.dir}`, '.');
      await expect(getChanges({ cwd: shallow, base: 'origin/main', feature: `origin/${repo.featureBranch}` })).rejects.toThrow(
        /no common history.*shallow clone.*fetch-depth: 0/,
      );
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });
});

describe('excludeLocally', () => {
  let repo;
  afterEach(() => repo?.cleanup());
  const exclude = () => readFileSync(join(repo.dir, '.git/info/exclude'), 'utf8');

  it('keeps the generated script out of git add -A, once, without touching tracked files', async () => {
    repo = makeRepo({ feature: { 'a.js': '1\n' } });
    const root = git(repo.dir, 'rev-parse', '--show-toplevel');
    writeFiles(repo.dir, { 'pr-split.sh': '#!/usr/bin/env bash\n', 'sub/stack.sh': 'x\n' });
    expect(await excludeLocally({ root, file: join(repo.dir, 'pr-split.sh') })).toBe(true);
    expect(await excludeLocally({ root, file: join(repo.dir, 'pr-split.sh') })).toBe(false);
    expect(await excludeLocally({ root, file: join(repo.dir, 'sub/stack.sh') })).toBe(true);
    expect(exclude().match(/^\/pr-split\.sh$/gm)).toHaveLength(1);
    expect(exclude()).toMatch(/^\/sub\/stack\.sh$/m);
    expect(git(repo.dir, 'status', '--porcelain')).toBe('');
    // Tracked files, odd names and paths outside the work tree are left alone.
    expect(await excludeLocally({ root, file: join(repo.dir, 'README.md') })).toBe(false);
    writeFiles(repo.dir, { 'odd [name].sh': 'x\n' });
    expect(await excludeLocally({ root, file: join(repo.dir, 'odd [name].sh') })).toBe(false);
    expect(await excludeLocally({ root, file: join(tmpdir(), 'elsewhere.sh') })).toBe(false);
  });
});

describe('assertRemote', () => {
  let repo;
  afterEach(() => repo?.cleanup());

  it('accepts an existing remote and rejects missing or flag-like names with a usage error', async () => {
    repo = makeRepo({ feature: { 'a.js': '1\n' } });
    git(repo.dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
    await expect(assertRemote({ cwd: repo.dir, remote: 'origin' })).resolves.toBeUndefined();
    await expect(assertRemote({ cwd: repo.dir, remote: 'upstream' })).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringMatching(/no git remote named "upstream"/),
    });
    await expect(assertRemote({ cwd: repo.dir, remote: '-v' })).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('repoRoot', () => {
  let repo;
  afterEach(() => repo?.cleanup());

  it('finds the repo root from a subdirectory', async () => {
    repo = makeRepo();
    const sub = join(repo.dir, 'deep', 'er');
    mkdirSync(sub, { recursive: true });
    expect(await repoRoot(sub)).toBe(git(repo.dir, 'rev-parse', '--show-toplevel'));
  });

  it('explains when the directory is not a git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-split-norepo-'));
    try {
      await expect(repoRoot(dir)).rejects.toThrow(/not inside a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});

describe('getChanges ref names for the script', () => {
  let repo;
  afterEach(() => repo?.cleanup());

  it('keeps branch and tag names, and resolves HEAD to the checked-out branch', async () => {
    repo = makeRepo({ feature: { 'a.js': '1\n' } });
    git(repo.dir, 'tag', 'v1', 'main');
    expect(await getChanges({ cwd: repo.dir, base: 'main', feature: 'HEAD' })).toMatchObject({
      baseRef: 'main',
      featureRef: repo.featureBranch,
    });
    expect((await getChanges({ cwd: repo.dir, base: 'v1', feature: repo.featureBranch })).baseRef).toBe('v1');
  });

  it('pins anything that is not a branch or tag (HEAD~1, SHAs, detached HEAD) to its commit', async () => {
    repo = makeRepo({ feature: { 'a.js': '1\n' } });
    const mainSha = git(repo.dir, 'rev-parse', 'main');
    const featureSha = git(repo.dir, 'rev-parse', 'HEAD');
    expect(await getChanges({ cwd: repo.dir, base: 'HEAD~1', feature: featureSha })).toMatchObject({
      baseRef: mainSha,
      featureRef: featureSha,
    });
    git(repo.dir, 'checkout', '-q', '--detach');
    expect((await getChanges({ cwd: repo.dir, base: 'main', feature: 'HEAD' })).featureRef).toBe(featureSha);
  });
});
