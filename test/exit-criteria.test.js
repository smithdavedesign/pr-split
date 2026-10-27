// ROADMAP.md M1 exit criteria, one describe block each.
// EC1 ("npm test passes for the core analyzer module") is covered by the unit suites:
// git.test.js, categorize.test.js, llm.test.js, config.test.js.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import {
  API_FILES,
  BIN,
  DB_FILES,
  capture,
  git,
  makeRepo,
  scriptEnv,
  snapshot,
  startFakeOllama,
} from './helpers.js';

const DB_PATHS = Object.keys(DB_FILES).sort();
const API_PATHS = Object.keys(API_FILES).sort();
const paths = (group) => group.files.map((f) => f.path).sort();

async function runCli(repo, extraArgs, opts = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(['--base', 'main', '--feature', repo.featureBranch, ...extraArgs], {
    cwd: repo.dir,
    env: {},
    stdout,
    stderr,
    ...opts,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('EC2: 5 database + 5 API files → exactly two groups, "database" and "api"', () => {
  let repo;
  beforeAll(() => {
    repo = makeRepo({ feature: { ...DB_FILES, ...API_FILES } });
  });
  afterAll(() => repo.cleanup());

  it('groups by path heuristics with --no-llm', async () => {
    const { code, stdout, stderr } = await runCli(repo, ['--no-llm', '--json']);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.source).toBe('heuristic');
    expect(plan.groups.map((g) => g.name)).toEqual(['database', 'api']);
    expect(paths(plan.groups[0])).toEqual(DB_PATHS);
    expect(paths(plan.groups[1])).toEqual(API_PATHS);
  });

  it('groups with Ollama (stubbed /api/chat) and sends it every changed file', async () => {
    const ollama = await startFakeOllama(() => ({
      groups: [
        { name: 'Database', description: 'Tables, seeds and the data layer', files: Object.keys(DB_FILES) },
        { name: 'API', description: 'HTTP endpoints using the data layer', files: Object.keys(API_FILES) },
      ],
    }));
    try {
      const { code, stdout, stderr } = await runCli(repo, ['--json'], { env: { OLLAMA_HOST: ollama.host } });
      expect(stderr).toBe('');
      expect(code).toBe(0);
      const plan = JSON.parse(stdout);
      expect(plan.source).toBe('ollama');
      expect(plan.groups.map((g) => g.name)).toEqual(['database', 'api']);
      expect(paths(plan.groups[0])).toEqual(DB_PATHS);
      expect(paths(plan.groups[1])).toEqual(API_PATHS);

      expect(ollama.requests).toHaveLength(1);
      expect(ollama.requests[0].url).toBe('/api/chat');
      const prompt = ollama.requests[0].body.messages.map((m) => m.content).join('\n');
      for (const path of [...DB_PATHS, ...API_PATHS]) expect(prompt).toContain(JSON.stringify(path));
    } finally {
      await ollama.close();
    }
  });

  it('still outputs the two groups when Ollama is down, with a warning', async () => {
    const fetchImpl = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    const { code, stdout, stderr } = await runCli(repo, ['--json'], { fetchImpl });
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.source).toBe('heuristic');
    expect(plan.groups.map((g) => g.name)).toEqual(['database', 'api']);
    expect(stderr).toMatch(/couldn't group with Ollama/);
    expect(stderr).toMatch(/ECONNREFUSED/);
  });

  it('the bin prints exactly two groups in its human-readable summary', () => {
    const result = spawnSync(process.execPath, [BIN, '--base', 'main', '--feature', repo.featureBranch, '--no-llm'], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: scriptEnv(),
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/10 files.*2 stacked PRs/);
    expect(result.stdout).toMatch(/^1\. database\b/m);
    expect(result.stdout).toMatch(/^2\. api\b/m);
    expect(result.stdout).not.toMatch(/^3\. /m);
  });
});

describe('EC3: the dry-run script has the right git checkout and git cherry-pick commands for each group', () => {
  let repo;
  let plan;
  let script;
  let scriptPath;
  beforeAll(async () => {
    repo = makeRepo({ feature: { ...DB_FILES, ...API_FILES } });
    const { code, stdout } = await runCli(repo, ['--no-llm', '--json', '--script', 'split.sh']);
    expect(code).toBe(0);
    plan = JSON.parse(stdout);
    scriptPath = join(repo.dir, 'split.sh');
    expect(plan.script).toBe(scriptPath);
    script = readFileSync(scriptPath, 'utf8');
  });
  afterAll(() => repo.cleanup());

  it('step 1: checks out each group\'s files from the feature onto the merge base', () => {
    expect(plan.mergeBase).toBe(git(repo.dir, 'merge-base', 'main', repo.featureBranch));
    expect(plan.featureSha).toBe(git(repo.dir, 'rev-parse', repo.featureBranch));
    for (const group of plan.groups) {
      const files = group.files.map((f) => `'${f.path}'`).join(' ');
      expect(script).toContain(
        `run git checkout -q -B '${group.tempBranch}' '${plan.mergeBase}'\n` +
          `run git checkout '${plan.featureSha}' -- ${files}\n`,
      );
    }
  });

  it('step 2: stacks each layer on the previous one with git checkout + git cherry-pick', () => {
    expect(plan.groups.map((g) => [g.branch, g.parent])).toEqual([
      ['pr-split/01-database', 'main'],
      ['pr-split/02-api', 'pr-split/01-database'],
    ]);
    for (const group of plan.groups) {
      expect(script).toContain(
        `run git checkout -q -B '${group.branch}' '${group.parent}'\nrun git cherry-pick '${group.tempBranch}'\n`,
      );
    }
  });

  it('puts the commands in order: every group commit first, then the layers bottom-up', () => {
    const at = (text) => {
      const index = script.indexOf(text);
      expect(index, text).toBeGreaterThan(-1);
      return index;
    };
    const [db, api] = plan.groups;
    const order = [
      at(`-B '${db.tempBranch}'`),
      at(`-B '${api.tempBranch}'`),
      at(`-B '${db.branch}'`),
      at(`git cherry-pick '${db.tempBranch}'`),
      at(`-B '${api.branch}'`),
      at(`git cherry-pick '${api.tempBranch}'`),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('is a dry run: running it prints every command and changes nothing', () => {
    const before = snapshot(repo.dir);
    const result = spawnSync('bash', [scriptPath], { cwd: repo.dir, encoding: 'utf8', env: scriptEnv() });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`+ git checkout -q -B pr-split/tmp/01-database ${plan.mergeBase}`);
    expect(result.stdout).toContain('+ git checkout -q -B pr-split/01-database main');
    expect(result.stdout).toContain('+ git cherry-pick pr-split/tmp/01-database');
    expect(result.stdout).toContain('+ git checkout -q -B pr-split/02-api pr-split/01-database');
    expect(result.stdout).toContain('+ git cherry-pick pr-split/tmp/02-api');
    expect(snapshot(repo.dir)).toEqual(before);
  });

  it('the commands are correct: executed in the throwaway repo they build the planned stack', () => {
    const result = spawnSync('bash', [scriptPath], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: scriptEnv({ PR_SPLIT_EXECUTE: '1' }),
    });
    expect(result.status, result.stderr).toBe(0);
    const changed = (from, to) => git(repo.dir, 'diff', '--name-only', from, to).split('\n').sort();
    expect(changed('main', 'pr-split/01-database')).toEqual(DB_PATHS);
    expect(changed('pr-split/01-database', 'pr-split/02-api')).toEqual(API_PATHS);
    const sha = (ref) => git(repo.dir, 'rev-parse', ref);
    expect(sha('pr-split/01-database~1')).toBe(sha('main'));
    expect(sha('pr-split/02-api~1')).toBe(sha('pr-split/01-database'));
    expect(sha('pr-split/02-api^{tree}')).toBe(sha(`${repo.featureBranch}^{tree}`));
    expect(git(repo.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(repo.featureBranch);
    expect(git(repo.dir, 'branch', '--list', 'pr-split/tmp/*')).toBe('');
  });
});

describe('EC4: the validation step calls the configured build/test/lint commands', () => {
  const CONFIG = 'base: main\nvalidate:\n  build: npm run build\n  test: npm test\n  lint: npm run lint\n';
  let repo;
  let plan;
  let script;
  beforeAll(async () => {
    repo = makeRepo({ base: { '.pr-split.yml': CONFIG }, feature: { ...DB_FILES, ...API_FILES } });
    const stdout = capture();
    const code = await main(['--feature', repo.featureBranch, '--no-llm', '--json'], {
      cwd: repo.dir,
      env: {},
      stdout,
      stderr: capture(),
    });
    expect(code).toBe(0);
    plan = JSON.parse(stdout.text);
    script = readFileSync(plan.script, 'utf8');
  });
  afterAll(() => repo.cleanup());

  it('reads the commands from .pr-split.yml in their configured order', () => {
    expect(plan.validate).toEqual([
      { name: 'build', command: 'npm run build' },
      { name: 'test', command: 'npm test' },
      { name: 'lint', command: 'npm run lint' },
    ]);
  });

  it('runs build, test and lint right after every layer is cherry-picked', () => {
    for (const group of plan.groups) {
      const block = script.slice(script.indexOf(`run git cherry-pick '${group.tempBranch}'\n`));
      expect(block.split('\n').slice(1, 4)).toEqual([
        "validate 'build' 'npm run build'",
        "validate 'test' 'npm test'",
        "validate 'lint' 'npm run lint'",
      ]);
    }
    expect(script.split("validate 'build' 'npm run build'").length - 1).toBe(plan.groups.length);
  });

  it('prints the validation commands during a dry run without running them', () => {
    const result = spawnSync('bash', [plan.script], { cwd: repo.dir, encoding: 'utf8', env: scriptEnv() });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('+ [validate:build] npm run build');
    expect(result.stdout).toContain('+ [validate:test] npm test');
    expect(result.stdout).toContain('+ [validate:lint] npm run lint');
  });

  it('actually runs each configured command on each layer when executed', async () => {
    const markers = mkdtempSync(join(tmpdir(), 'pr-split-markers-'));
    const log = join(markers, 'validate.log');
    const command = (name) => JSON.stringify(`echo "${name} $(git branch --show-current)" >> '${log}'`);
    const config = `validate:\n  build: ${command('build')}\n  test: ${command('test')}\n  lint: ${command('lint')}\n`;
    const exec = makeRepo({ base: { '.pr-split.yml': config }, feature: { ...DB_FILES, ...API_FILES } });
    try {
      const stdout = capture();
      const code = await main(['--feature', exec.featureBranch, '--no-llm', '--json'], {
        cwd: exec.dir,
        env: {},
        stdout,
        stderr: capture(),
      });
      expect(code).toBe(0);
      const result = spawnSync('bash', [JSON.parse(stdout.text).script], {
        cwd: exec.dir,
        encoding: 'utf8',
        env: scriptEnv({ PR_SPLIT_EXECUTE: '1' }),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        'build pr-split/01-database',
        'test pr-split/01-database',
        'lint pr-split/01-database',
        'build pr-split/02-api',
        'test pr-split/02-api',
        'lint pr-split/02-api',
      ]);
    } finally {
      exec.cleanup();
      rmSync(markers, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!process.env.PR_SPLIT_LIVE_OLLAMA)('EC2 against a real local Ollama (PR_SPLIT_LIVE_OLLAMA=1)', () => {
  it('splits 5 database + 5 API files into "database" and "api"', async () => {
    const repo = makeRepo({ feature: { ...DB_FILES, ...API_FILES } });
    try {
      const { code, stdout } = await runCli(repo, ['--json'], { env: process.env });
      expect(code).toBe(0);
      const plan = JSON.parse(stdout);
      expect(plan.source).toBe('ollama');
      expect(plan.groups.map((g) => g.name)).toEqual(['database', 'api']);
      expect(paths(plan.groups[0])).toEqual(DB_PATHS);
      expect(paths(plan.groups[1])).toEqual(API_PATHS);
    } finally {
      repo.cleanup();
    }
  }, 600_000);
});
