import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { buildPlan } from '../src/plan.js';
import { FILES_PER_COMMAND, renderScript, shellQuote } from '../src/script.js';
import { capture, commitAll, git, makeRepo, scriptEnv, writeFiles } from './helpers.js';

const MERGE_BASE = 'a'.repeat(40);
const FEATURE_SHA = 'b'.repeat(40);
const file = (path, extra = {}) => ({ path, status: 'A', additions: 1, deletions: 0, binary: false, ...extra });

function plan({ groups, validate = [], ...options }) {
  return buildPlan({
    base: 'main',
    feature: 'feature/x',
    mergeBase: MERGE_BASE,
    featureSha: FEATURE_SHA,
    groups,
    validate,
    source: 'heuristic',
    model: null,
    warnings: [],
    ...options,
  });
}

const TWO_GROUPS = [
  { name: 'database', description: 'Tables', files: [file('db/a.sql')] },
  { name: 'api', description: 'Endpoints', files: [file('src/api/a.js')] },
];

const bashSyntaxOk = (script) => spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' }).status === 0;

describe('shellQuote', () => {
  it.each(['plain', 'with space', "it's", '$(rm -rf ~)', '`id`', 'a\nb', '"double" and \\back', ''])(
    'round-trips %j through bash unchanged',
    (value) => {
      expect(execFileSync('bash', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' })).toBe(value);
    },
  );

  it('rejects NUL bytes, which no shell argument can hold', () => {
    expect(() => shellQuote('a\0b')).toThrow(/NUL/);
  });
});

describe('renderScript', () => {
  it('is a bash script that stops at the first error and is a dry run by default', () => {
    const script = renderScript(plan({ groups: [{ name: 'api', description: 'Endpoints', files: [file('src/api/a.js')] }] }));
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('EXECUTE="${PR_SPLIT_EXECUTE:-0}"');
    expect(bashSyntaxOk(script)).toBe(true);
  });

  it('removes deleted files and rename sources with git rm, and checks out the rest', () => {
    const script = renderScript(
      plan({
        groups: [
          {
            name: 'database',
            description: '',
            files: [
              file('db/new.sql'),
              file('db/gone.sql', { status: 'D' }),
              file('db/renamed.sql', { status: 'R', oldPath: 'db/original.sql' }),
            ],
          },
        ],
      }),
    );
    expect(script).toContain(`run git checkout '${FEATURE_SHA}' -- 'db/new.sql' 'db/renamed.sql'\n`);
    expect(script).toContain("run git rm -q -- 'db/gone.sql' 'db/original.sql'\n");
    expect(script).not.toMatch(/checkout '[0-9a-f]+' -- .*gone\.sql/);
  });

  it('skips git checkout for a group that only deletes files', () => {
    const script = renderScript(plan({ groups: [{ name: 'cleanup', description: '', files: [file('old.js', { status: 'D' })] }] }));
    expect(script).not.toContain(`run git checkout '${FEATURE_SHA}'`);
    expect(script).toContain("run git rm -q -- 'old.js'\n");
  });

  it(`splits long file lists into commands of ${FILES_PER_COMMAND} files`, () => {
    const files = Array.from({ length: FILES_PER_COMMAND * 2 + 3 }, (_, i) => file(`src/api/f${i}.js`));
    const script = renderScript(plan({ groups: [{ name: 'api', description: '', files }] }));
    const checkouts = script.split('\n').filter((line) => line.startsWith(`run git checkout '${FEATURE_SHA}' -- `));
    expect(checkouts).toHaveLength(3);
    expect(checkouts.join(' ').match(/'src\/api\/f\d+\.js'/g)).toHaveLength(files.length);
  });

  it('quotes hostile file names and descriptions so they stay data', () => {
    const script = renderScript(
      plan({
        groups: [{ name: 'api', description: "it's $(whoami)", files: [file("src/api/it's $(id) `x`.js")] }],
        validate: [{ name: "o'clock", command: "echo 'hi' && true" }],
      }),
    );
    expect(script).toContain(`'src/api/it'\\''s $(id) \`x\`.js'`);
    // M2 made the subject a conventional commit; the hostile description must still stay quoted data.
    expect(script).toContain(`run git commit -q -m 'feat(api): it'\\''s $(whoami)'`);
    expect(script).toContain(`validate 'o'\\''clock' 'echo '\\''hi'\\'' && true'`);
    expect(bashSyntaxOk(script)).toBe(true);
  });

  it('never lets a newline in a name break out of a comment', () => {
    const hostile = buildPlan({
      base: 'main\ntouch pwned-base',
      feature: 'feature\ntouch pwned-feature',
      mergeBase: MERGE_BASE,
      featureSha: FEATURE_SHA,
      groups: [{ name: 'api', description: '', files: [file('src/api/a.js')] }],
      validate: [],
      source: 'heuristic',
      model: null,
      warnings: [],
    });
    const script = renderScript(hostile);
    expect(script).not.toMatch(/^# .*\ntouch pwned/m);
    expect(bashSyntaxOk(script)).toBe(true);
    // Newlines inside quoted arguments are inert; a broken-out comment would run `touch` even in a dry run.
    const dir = mkdtempSync(join(tmpdir(), 'pr-split-hostile-'));
    try {
      const result = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: scriptEnv() });
      expect(result.status, result.stderr).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says so when no validation commands are configured', () => {
    const script = renderScript(plan({ groups: [{ name: 'api', description: '', files: [file('src/api/a.js')] }] }));
    expect(script).toContain('# No validation commands configured');
    expect(script).not.toMatch(/^validate /m);
  });

  it('checks that existing layer branches are its own before executing, unless --force', () => {
    const checked = renderScript(plan({ groups: TWO_GROUPS }));
    expect(checked).toContain("  check_branch 'pr-split/01-database'\n  check_branch 'pr-split/02-api'\n");
    expect(checked).toContain("MARKER=' of feature/x, split by pr-split.'");
    const forced = renderScript(plan({ groups: TWO_GROUPS, force: true }));
    expect(forced).not.toMatch(/^\s*check_branch '/m);
    expect(forced).toContain('# --force: existing pr-split branches are overwritten without checking');
    expect(bashSyntaxOk(checked) && bashSyntaxOk(forced)).toBe(true);
  });

  it('pushes the whole stack once, after cleanup, only when asked', () => {
    expect(renderScript(plan({ groups: TWO_GROUPS }))).not.toContain('git push');
    const script = renderScript(plan({ groups: TWO_GROUPS, push: 'origin' }));
    const push = "run git push --force-with-lease -u 'origin' 'pr-split/01-database' 'pr-split/02-api'\n";
    expect(script).toContain(push);
    expect(script.indexOf(push)).toBeGreaterThan(script.indexOf('run git branch -q -D'));
    expect(script).toContain("  git remote get-url 'origin' >/dev/null");
    expect(bashSyntaxOk(script)).toBe(true);
  });

  it('renders the retry count and the issue trailer', () => {
    const script = renderScript(plan({ groups: TWO_GROUPS, retries: 3, issue: 'ABC-1' }));
    expect(script).toContain('\nRETRIES=3\n');
    expect(script).toContain(
      "run git commit -q -m 'feat(database): tables' -m 'Part 1/2 of feature/x, split by pr-split.' -m 'Refs: ABC-1'\n",
    );
  });

  it('installs the failure handler only when executing, after the clean-tree check', () => {
    const script = renderScript(plan({ groups: TWO_GROUPS }));
    const preflight = script.slice(script.indexOf('if [ "$EXECUTE" = 1 ]; then\n  cd'));
    expect(preflight.indexOf('commit or stash')).toBeLessThan(preflight.indexOf('trap on_exit EXIT'));
    expect(script.match(/trap on_exit EXIT/g)).toHaveLength(1);
  });

  it('returns to the feature branch and deletes the temporary branches at the end', () => {
    const script = renderScript(
      plan({
        groups: [
          { name: 'database', description: '', files: [file('db/a.sql')] },
          { name: 'api', description: '', files: [file('src/api/a.js')] },
        ],
      }),
    );
    const tail = script.slice(script.lastIndexOf('git cherry-pick'));
    expect(tail).toContain("run git checkout -q 'feature/x'\n");
    expect(tail).toContain("run git branch -q -D 'pr-split/tmp/01-database' 'pr-split/tmp/02-api'\n");
  });
});

describe('running the generated script', () => {
  let repo;
  afterEach(() => repo?.cleanup());

  async function generate(target) {
    const stdout = capture();
    const code = await main(['--base', 'main', '--feature', target.featureBranch, '--no-llm', '--json'], {
      cwd: target.dir,
      env: {},
      stdout,
      stderr: capture(),
    });
    expect(code).toBe(0);
    return JSON.parse(stdout.text);
  }

  const execute = (target, scriptPath) =>
    spawnSync('bash', [scriptPath], { cwd: target.dir, encoding: 'utf8', env: scriptEnv({ PR_SPLIT_EXECUTE: '1' }) });

  it('refuses to execute on a dirty working tree and changes nothing', async () => {
    repo = makeRepo({ base: { 'src/api/a.js': '1\n' }, feature: { 'db/a.sql': 'x\n', 'src/api/a.js': '2\n' } });
    const { script } = await generate(repo);
    writeFiles(repo.dir, { 'src/api/a.js': 'uncommitted work\n' });
    const result = execute(repo, script);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/commit or stash/);
    expect(readFileSync(`${repo.dir}/src/api/a.js`, 'utf8')).toBe('uncommitted work\n');
    expect(git(repo.dir, 'branch', '--list', 'pr-split/*')).toBe('');
  });

  it('keeps commits that landed on base after branching (cherry-pick merges, it does not overwrite)', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `-- line ${i + 1}`);
    repo = makeRepo({
      base: { 'db/schema.sql': lines.join('\n') + '\n' },
      feature: { 'db/schema.sql': ['-- feature edit', ...lines.slice(1)].join('\n') + '\n', 'src/api/a.js': '1\n' },
    });
    git(repo.dir, 'checkout', '-q', 'main');
    writeFiles(repo.dir, { 'db/schema.sql': [...lines.slice(0, -1), '-- upstream edit'].join('\n') + '\n' });
    commitAll(repo.dir, 'upstream change');
    git(repo.dir, 'checkout', '-q', repo.featureBranch);

    const { script } = await generate(repo);
    const result = execute(repo, script);
    expect(result.status, result.stderr).toBe(0);
    const schema = git(repo.dir, 'show', 'pr-split/01-database:db/schema.sql');
    expect(schema).toContain('-- feature edit');
    expect(schema).toContain('-- upstream edit');
    expect(git(repo.dir, 'rev-parse', 'pr-split/01-database~1')).toBe(git(repo.dir, 'rev-parse', 'main'));
  });

  it('builds on the planned commits even when base and feature are given relative to HEAD', async () => {
    repo = makeRepo({ feature: { 'db/a.sql': 'x\n', 'src/api/a.js': '1\n' } });
    const stdout = capture();
    const code = await main(['--base', 'HEAD~1', '--feature', 'HEAD', '--no-llm', '--json'], {
      cwd: repo.dir,
      env: {},
      stdout,
      stderr: capture(),
    });
    expect(code).toBe(0);
    const { script, groups } = JSON.parse(stdout.text);
    expect(groups[0].parent).toBe(git(repo.dir, 'rev-parse', 'main'));
    const result = execute(repo, script);
    expect(result.status, result.stderr).toBe(0);
    expect(git(repo.dir, 'rev-parse', 'pr-split/01-database~1')).toBe(git(repo.dir, 'rev-parse', 'main'));
    expect(git(repo.dir, 'diff', '--name-only', 'pr-split/01-database', 'pr-split/02-api')).toBe('src/api/a.js');
    expect(git(repo.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(repo.featureBranch);
  });

  it('treats paths literally, so a name like "[id]" is not a glob that grabs other groups\' files', async () => {
    repo = makeRepo({ feature: { 'src/[ad]pi/x.js': 'literal\n', 'src/api/x.js': 'api\n' } });
    const plan = await generate(repo);
    expect(plan.groups.map((g) => [g.name, g.files.map((f) => f.path)])).toEqual([
      ['shared', ['src/[ad]pi/x.js']],
      ['api', ['src/api/x.js']],
    ]);
    const result = execute(repo, plan.script);
    expect(result.status, result.stderr).toBe(0);
    expect(git(repo.dir, 'diff', '--name-only', 'main', 'pr-split/01-shared')).toBe('src/[ad]pi/x.js');
    expect(git(repo.dir, 'diff', '--name-only', 'pr-split/01-shared', 'pr-split/02-api')).toBe('src/api/x.js');
  });

  it('applies renames and deletions in the layer they belong to', async () => {
    repo = makeRepo({
      base: { 'src/db/old-name.js': 'export const db = 1;\n'.repeat(5), 'src/api/legacy.js': 'export {};\n' },
      rename: [['src/db/old-name.js', 'src/db/new-name.js']],
      remove: ['src/api/legacy.js'],
      feature: { 'src/api/users.js': 'export const users = [];\n' },
    });
    const plan = await generate(repo);
    expect(plan.groups.map((g) => g.name)).toEqual(['database', 'api']);
    const result = execute(repo, plan.script);
    expect(result.status, result.stderr).toBe(0);
    const tree = (ref) => git(repo.dir, 'ls-tree', '-r', '--name-only', ref).split('\n');
    expect(tree('pr-split/01-database')).toEqual(
      expect.arrayContaining(['src/db/new-name.js', 'src/api/legacy.js']),
    );
    expect(tree('pr-split/01-database')).not.toContain('src/db/old-name.js');
    expect(tree('pr-split/02-api')).toEqual(expect.arrayContaining(['src/db/new-name.js', 'src/api/users.js']));
    expect(tree('pr-split/02-api')).not.toContain('src/api/legacy.js');
    expect(git(repo.dir, 'rev-parse', 'pr-split/02-api^{tree}')).toBe(
      git(repo.dir, 'rev-parse', `${repo.featureBranch}^{tree}`),
    );
  });
});
