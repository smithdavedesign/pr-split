// End to end, the way a person runs it: the bin, human-readable output, push and issue reference.
// Checks that the report reads in order: the plan, then each layer passing, then the push.
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BIN, addBareRemote, branches, makeStackRepo, scriptEnv } from './helpers.js';

let repo;
let remote;
let result;
beforeAll(() => {
  repo = makeStackRepo({ validate: { build: 'node scripts/check.mjs' } });
  remote = addBareRemote(repo);
  result = spawnSync(process.execPath, [BIN, '--base', 'main', '--execute', '--no-llm', '--push', '--issue', '42'], {
    cwd: repo.dir,
    encoding: 'utf8',
    env: scriptEnv(),
  });
});
afterAll(() => {
  repo.cleanup();
  remote.cleanup();
});

it('prints the plan before running anything, then the commands it runs', () => {
  expect(result.status, result.stderr).toBe(0);
  const at = (text) => {
    const index = result.stdout.indexOf(text);
    expect(index, text).toBeGreaterThan(-1);
    return index;
  };
  const order = [
    at('7 files, 12 changed lines → 3 stacked PRs'),
    at('Commits reference: #42'),
    at('Push: to origin once every layer has passed'),
    at('Running pr-split.sh now (--execute)'),
    at('+ git cherry-pick pr-split/tmp/01-database'),
    at('+ [validate:build] node scripts/check.mjs'),
    at('+ git push --force-with-lease -u origin pr-split/01-database pr-split/02-api pr-split/03-ui'),
  ];
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

it('reports each layer as it passes and ends with what was created and pushed', () => {
  const report = result.stderr.split('\n').filter((line) => line.startsWith('pr-split: '));
  expect(report).toEqual([
    'pr-split: pr-split/01-database passed validation (build)',
    'pr-split: pr-split/02-api passed validation (build)',
    'pr-split: pr-split/03-ui passed validation (build)',
    'pr-split: pushed 3 branches to origin',
    'pr-split: created 3 branches (each passed: build): pr-split/01-database pr-split/02-api pr-split/03-ui',
  ]);
  expect(branches(remote.dir)).toEqual(['pr-split/01-database', 'pr-split/02-api', 'pr-split/03-ui']);
});
