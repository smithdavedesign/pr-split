import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { API_FILES, DB_FILES, capture, makeRepo, startFakeOllama } from './helpers.js';

const { version } = createRequire(import.meta.url)('../package.json');

async function run(argv, opts = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, { env: {}, stdout, stderr, ...opts });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('cli basics', () => {
  it('--help prints usage and exits 0', async () => {
    const { code, stdout } = await run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^Usage: pr-split/);
    for (const flag of ['--base', '--feature', '--config', '--script', '--model', '--no-llm', '--json', '--dry-run']) {
      expect(stdout).toContain(flag);
    }
  });

  it('--version prints the package version', async () => {
    const { code, stdout } = await run(['--version']);
    expect(code).toBe(0);
    expect(stdout).toBe(`${version}\n`);
  });

  it('exits 2 on an unknown flag or a stray argument, with a pointer to --help', async () => {
    for (const argv of [['--frobnicate'], ['main']]) {
      const { code, stderr } = await run(argv);
      expect(code).toBe(2);
      expect(stderr).toMatch(/pr-split --help/);
    }
  });

  it('exits 1 outside a git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-split-cli-'));
    try {
      const { code, stderr } = await run(['--no-llm'], { cwd: dir });
      expect(code).toBe(1);
      expect(stderr).toMatch(/not inside a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cli on a repo', () => {
  let repo;
  beforeAll(() => {
    repo = makeRepo({ feature: { ...DB_FILES, ...API_FILES } });
  });
  afterAll(() => repo.cleanup());

  it('defaults --feature to the current branch and --base to main', async () => {
    const { code, stdout } = await run(['--no-llm', '--json'], { cwd: repo.dir });
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.feature).toBe(repo.featureBranch);
    expect(plan.base).toBe('main');
  });

  it('prints a summary with files per PR, branches and the review-effort reduction', async () => {
    const { code, stdout } = await run(['--no-llm', '--dry-run'], { cwd: repo.dir });
    expect(code).toBe(0);
    expect(stdout).toContain(`pr-split: ${repo.featureBranch} → main`);
    expect(stdout).toMatch(/grouped by file paths/);
    expect(stdout).toMatch(/branch pr-split\/01-database \(based on main\) · 5 files/);
    expect(stdout).toMatch(/branch pr-split\/02-api \(based on pr-split\/01-database\) · 5 files/);
    expect(stdout).toContain('A  db/migrations/001_create_users.sql');
    expect(stdout).toMatch(/largest PR has 5 files .* instead of 10 files .*\(\d+% smaller\)/);
    expect(stdout).toMatch(/No validation commands configured/);
    expect(stdout).toMatch(/Dry-run script: pr-split\.sh/);
  });

  it('writes the script where --script points and makes it executable', async () => {
    const out = mkdtempSync(join(tmpdir(), 'pr-split-out-'));
    try {
      const target = join(out, 'stack.sh');
      const { code, stdout } = await run(['--no-llm', '--json', '--script', target], { cwd: repo.dir });
      expect(code).toBe(0);
      expect(JSON.parse(stdout).script).toBe(target);
      expect(readFileSync(target, 'utf8')).toMatch(/^#!\/usr\/bin\/env bash/);
      expect(statSync(target).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('sends --model to Ollama, ahead of the configured model', async () => {
    const ollama = await startFakeOllama(() => ({
      groups: [{ name: 'everything', description: 'All of it', files: [...Object.keys(DB_FILES), ...Object.keys(API_FILES)] }],
    }));
    try {
      const { code, stdout } = await run(['--json', '--model', 'qwen2.5-coder:7b'], {
        cwd: repo.dir,
        env: { OLLAMA_HOST: ollama.host },
      });
      expect(code).toBe(0);
      const plan = JSON.parse(stdout);
      expect(plan.model).toBe('qwen2.5-coder:7b');
      expect(plan.groups.map((g) => g.name)).toEqual(['everything']);
      expect(ollama.requests[0].body.model).toBe('qwen2.5-coder:7b');
    } finally {
      await ollama.close();
    }
  });

  it('falls back to file paths with a warning when the model answers with prose', async () => {
    const ollama = await startFakeOllama(() => 'I would split this into a database PR and an API PR.');
    try {
      const { code, stdout, stderr } = await run(['--json'], { cwd: repo.dir, env: { OLLAMA_HOST: ollama.host } });
      expect(code).toBe(0);
      const plan = JSON.parse(stdout);
      expect(plan.source).toBe('heuristic');
      expect(plan.model).toBeNull();
      expect(plan.groups.map((g) => g.name)).toEqual(['database', 'api']);
      expect(stderr).toMatch(/warning: couldn't group with Ollama \(.*not valid JSON\)/);
      expect(plan.warnings).toHaveLength(1);
    } finally {
      await ollama.close();
    }
  });

  it('exits 1 with a clear message when there is nothing to split', async () => {
    const { code, stderr } = await run(['--base', repo.featureBranch, '--no-llm'], { cwd: repo.dir });
    expect(code).toBe(1);
    expect(stderr).toMatch(/nothing to split/);
  });

  it('exits 2 on an unknown ref that looks like a flag', async () => {
    const { code } = await run(['--base=-p', '--no-llm'], { cwd: repo.dir });
    expect(code).toBe(2);
  });
});

describe('cli with .pr-split.yml', () => {
  let repo;
  afterEach(() => repo?.cleanup());

  it('takes base and model from the config file', async () => {
    repo = makeRepo({ base: { '.pr-split.yml': 'base: main\nmodel: phi4\n' }, feature: { 'src/api/a.js': '1\n' } });
    const ollama = await startFakeOllama(() => ({ groups: [{ name: 'api', description: '', files: ['src/api/a.js'] }] }));
    try {
      const { code, stdout } = await run(['--json'], { cwd: repo.dir, env: { OLLAMA_HOST: ollama.host } });
      expect(code).toBe(0);
      expect(JSON.parse(stdout).model).toBe('phi4');
      expect(ollama.requests[0].body.model).toBe('phi4');
    } finally {
      await ollama.close();
    }
  });

  it('exits 2 on an invalid config file', async () => {
    repo = makeRepo({ base: { '.pr-split.yml': 'validation:\n  test: npm test\n' }, feature: { 'src/api/a.js': '1\n' } });
    const { code, stderr } = await run(['--no-llm'], { cwd: repo.dir });
    expect(code).toBe(2);
    expect(stderr).toMatch(/unknown key "validation"/);
  });

  it('reads --config relative to the current directory', async () => {
    repo = makeRepo({ base: { 'ci/split.yml': 'validate:\n  test: make test\n' }, feature: { 'src/api/a.js': '1\n' } });
    const { code, stdout } = await run(['--no-llm', '--json', '--config', 'ci/split.yml'], { cwd: repo.dir });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).validate).toEqual([{ name: 'test', command: 'make test' }]);
  });
});
