import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, loadConfig, parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('reads base, model and validate, keeping the command order', () => {
    const config = parseConfig(
      'base: develop\nmodel: qwen2.5-coder:7b\nvalidate:\n  lint: npm run lint\n  build: npm run build\n  test: npm test -- --run\n',
    );
    expect(config).toEqual({
      base: 'develop',
      model: 'qwen2.5-coder:7b',
      validate: [
        { name: 'lint', command: 'npm run lint' },
        { name: 'build', command: 'npm run build' },
        { name: 'test', command: 'npm test -- --run' },
      ],
    });
  });

  it('treats an empty file or comments only as all defaults', () => {
    expect(parseConfig('')).toEqual({ base: undefined, model: undefined, validate: [] });
    expect(parseConfig('# nothing yet\n')).toEqual({ base: undefined, model: undefined, validate: [] });
    expect(parseConfig('validate:\n')).toEqual({ base: undefined, model: undefined, validate: [] });
  });

  it('rejects unknown keys, because a typo would silently skip validation', () => {
    expect(() => parseConfig('validation:\n  test: npm test\n')).toThrow(/unknown key "validation".*base, model, validate/);
    try {
      parseConfig('validation: {}\n');
    } catch (err) {
      expect(err.code).toBe('USAGE');
    }
  });

  it.each([
    ['a list under validate', 'validate:\n  - npm test\n', /validate.*mapping/],
    ['a non-string command', 'validate:\n  test: 42\n', /validate\.test.*non-empty string/],
    ['an empty command', 'validate:\n  test: ""\n', /validate\.test.*non-empty string/],
    ['a non-string base', 'base: [main]\n', /base.*non-empty string/],
    ['a base that looks like a flag', 'base: --force\n', /base/],
    ['a list at the top level', '- base\n', /mapping/],
    ['invalid YAML', 'validate:\n  test: [unclosed\n', /\.pr-split\.yml: invalid YAML/],
    ['negative retries', 'retries: -1\n', /retries.*whole number from 0 to 10/],
    ['fractional retries', 'retries: 1.5\n', /retries.*whole number from 0 to 10/],
    ['retries as text', 'retries: "2"\n', /retries.*whole number from 0 to 10/],
    ['too many retries', 'retries: 11\n', /retries.*whole number from 0 to 10/],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseConfig(text, CONFIG_FILE)).toThrow(message);
  });

  it('reads retries, the number of extra attempts for a failing validation command', () => {
    expect(parseConfig('retries: 2\nvalidate:\n  test: npm test\n')).toEqual({
      base: undefined,
      model: undefined,
      retries: 2,
      validate: [{ name: 'test', command: 'npm test' }],
    });
    expect(parseConfig('retries: 0\n').retries).toBe(0);
    expect(parseConfig('').retries).toBeUndefined();
  });
});

describe('loadConfig', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pr-split-config-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('uses defaults when the repo has no .pr-split.yml', () => {
    expect(loadConfig({ root: dir })).toEqual({ base: undefined, model: undefined, validate: [], file: null });
  });

  it('reads .pr-split.yml from the repo root', () => {
    writeFileSync(join(dir, '.pr-split.yml'), 'base: trunk\nvalidate:\n  test: make test\n');
    expect(loadConfig({ root: dir })).toEqual({
      base: 'trunk',
      model: undefined,
      validate: [{ name: 'test', command: 'make test' }],
      file: join(dir, '.pr-split.yml'),
    });
  });

  it('reads an explicit config path and fails clearly when it is missing', () => {
    const custom = join(dir, 'split.yml');
    writeFileSync(custom, 'model: llama3.1\n');
    expect(loadConfig({ root: dir, path: custom }).model).toBe('llama3.1');
    expect(() => loadConfig({ root: dir, path: join(dir, 'missing.yml') })).toThrow(/config file not found/);
  });
});
