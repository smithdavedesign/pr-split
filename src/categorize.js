// Path-based grouping: the deterministic fallback when Ollama is off, down or unusable,
// and the backfill for files the model forgot to place.
import { extname } from 'node:path';

/** Groups in stack order: each group may only depend on the ones before it. */
export const GROUPS = [
  { name: 'config', description: 'Build, tooling and configuration' },
  { name: 'shared', description: 'Shared code and files no other group matched' },
  { name: 'database', description: 'Schema, migrations and data models' },
  { name: 'api', description: 'API routes, handlers and server code' },
  { name: 'ui', description: 'User interface: components, pages and styles' },
  { name: 'tests', description: 'Tests that are not tied to one layer' },
  { name: 'docs', description: 'Documentation' },
];

const DATABASE_DIRS = new Set(['db', 'database', 'databases', 'migrations', 'migrate', 'prisma', 'models', 'entities', 'seeds', 'seeders', 'schema', 'sql']);
const DATABASE_EXTENSIONS = new Set(['.sql', '.prisma']);
const API_DIRS = new Set(['api', 'apis', 'routes', 'controllers', 'handlers', 'endpoints', 'server', 'graphql', 'resolvers', 'middleware', 'rpc']);
const UI_DIRS = new Set(['components', 'pages', 'views', 'ui', 'styles', 'frontend', 'client', 'web', 'public', 'layouts']);
const UI_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.css', '.scss', '.sass', '.less', '.html']);
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e']);
const TEST_FILE = /(\.(test|spec)\.[^.]+$)|(_test\.go$)|(^test_.*\.py$)/;
const DOC_DIRS = new Set(['docs', 'doc']);
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst']);
const CONFIG_FILES = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'tsconfig.json', 'dockerfile',
  'docker-compose.yml', 'docker-compose.yaml', 'makefile', '.gitignore', '.npmrc', '.nvmrc', '.editorconfig',
  'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock', 'pyproject.toml', 'requirements.txt', 'gemfile', 'gemfile.lock',
]);
const CONFIG_FILE = /\.config\.[cm]?[jt]s$/;
const ROOT_CONFIG_EXTENSIONS = new Set(['.json', '.yml', '.yaml', '.toml', '.ini', '.cfg']);

/** @param {string} path repo-relative path */
export function categorize(path) {
  const parts = path.toLowerCase().split('/');
  const file = parts.pop();
  const dirs = parts;
  const ext = extname(file);
  const inDir = (set) => dirs.some((dir) => set.has(dir));

  if (DOC_DIRS.has(dirs[0])) return 'docs';
  if (inDir(DATABASE_DIRS) || DATABASE_EXTENSIONS.has(ext)) return 'database';
  if (inDir(API_DIRS)) return 'api';
  if (inDir(UI_DIRS) || UI_EXTENSIONS.has(ext)) return 'ui';
  if (inDir(TEST_DIRS) || TEST_FILE.test(file)) return 'tests';
  if (DOC_EXTENSIONS.has(ext)) return 'docs';
  if (
    dirs[0] === '.github' ||
    CONFIG_FILES.has(file) ||
    CONFIG_FILE.test(file) ||
    (dirs.length === 0 && (ROOT_CONFIG_EXTENSIONS.has(ext) || file.startsWith('.')))
  ) {
    return 'config';
  }
  return 'shared';
}

/**
 * Groups files by path, in GROUPS order, keeping the diff order inside each group.
 * @param {import('./git.js').ChangedFile[]} files
 */
export function heuristicGroups(files) {
  return GROUPS.map(({ name, description }) => ({
    name,
    description,
    files: files.filter((file) => categorize(file.path) === name),
  })).filter((group) => group.files.length > 0);
}
