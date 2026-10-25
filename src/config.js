// .pr-split.yml: base branch, Ollama model, the validation commands run after each layer and
// how often a failing one is retried.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { usageError } from './errors.js';

export const CONFIG_FILE = '.pr-split.yml';
const KEYS = ['base', 'model', 'validate', 'retries'];
/** Extra attempts per failing validation command; more than this is a flaky suite to fix, not retry. */
export const MAX_RETRIES = 10;

/**
 * @typedef {{ name: string, command: string }} ValidationCommand
 * @typedef {{ base?: string, model?: string, validate: ValidationCommand[], retries?: number }} Config
 */

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';
const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isRetryCount = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_RETRIES;

/** @returns {Config} */
export function parseConfig(text, source = CONFIG_FILE) {
  let data;
  try {
    data = parse(text);
  } catch (err) {
    throw usageError(`${source}: invalid YAML (${err.message.split('\n')[0]})`);
  }
  data ??= {};
  if (!isMapping(data)) throw usageError(`${source}: expected a mapping of keys, like "base: main"`);

  for (const key of Object.keys(data)) {
    if (!KEYS.includes(key)) {
      throw usageError(`${source}: unknown key "${key}" (allowed keys: ${KEYS.join(', ')})`);
    }
  }
  for (const key of ['base', 'model']) {
    if (data[key] !== undefined && data[key] !== null && !isNonEmptyString(data[key])) {
      throw usageError(`${source}: "${key}" must be a non-empty string`);
    }
  }
  if (typeof data.base === 'string' && data.base.startsWith('-')) {
    throw usageError(`${source}: "base" can't start with "-"`);
  }
  if (data.retries !== undefined && data.retries !== null && !isRetryCount(data.retries)) {
    throw usageError(`${source}: "retries" must be a whole number from 0 to ${MAX_RETRIES}`);
  }

  const validate = [];
  if (data.validate !== undefined && data.validate !== null) {
    if (!isMapping(data.validate)) {
      throw usageError(`${source}: "validate" must be a mapping of name: command, like "test: npm test"`);
    }
    for (const [name, command] of Object.entries(data.validate)) {
      if (!isNonEmptyString(command)) throw usageError(`${source}: "validate.${name}" must be a non-empty string`);
      validate.push({ name, command });
    }
  }
  return { base: data.base ?? undefined, model: data.model ?? undefined, validate, retries: data.retries ?? undefined };
}

/**
 * Reads `path` if given, else `<root>/.pr-split.yml` if it exists, else returns defaults.
 * @returns {Config & { file: string | null }}
 */
export function loadConfig({ root, path }) {
  const file = path ?? join(root, CONFIG_FILE);
  if (!existsSync(file)) {
    if (path) throw usageError(`config file not found: ${path}`);
    return { base: undefined, model: undefined, validate: [], retries: undefined, file: null };
  }
  return { ...parseConfig(readFileSync(file, 'utf8'), path ?? CONFIG_FILE), file };
}
