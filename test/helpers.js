import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/pr-split.js', import.meta.url));

export const DB_FILES = {
  'db/migrations/001_create_users.sql': 'CREATE TABLE users (id serial PRIMARY KEY, email text);\n',
  'db/migrations/002_create_orders.sql': 'CREATE TABLE orders (id serial PRIMARY KEY, user_id int);\n',
  'db/seeds/users.sql': 'INSERT INTO users (email) VALUES (null);\n',
  'src/db/connection.js': 'export function connect() {\n  return null;\n}\n',
  'src/models/order.js': 'export class Order {}\n',
};

export const API_FILES = {
  'src/api/users.js': 'export function listUsers() {\n  return [];\n}\n',
  'src/api/orders.js': 'export function listOrders() {\n  return [];\n}\n',
  'src/routes/index.js': "export const routes = ['/users', '/orders'];\n",
  'src/controllers/orders-controller.js': 'export const show = () => null;\n',
  'src/middleware/auth.js': 'export const auth = (req, res, next) => next();\n',
};

/** A tiny ESM project whose layers import each other (database ← api ← ui), checked by scripts/check.mjs. */
export const STACK_BASE = {
  'package.json': '{ "type": "module" }\n',
  'scripts/check.mjs': [
    '// Loads every module under src/, so a layer that needs code from a later layer fails.',
    "import { existsSync, readdirSync } from 'node:fs';",
    "import { join, resolve } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    'const walk = (dir) =>',
    '  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>',
    "    entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.js') ? [join(dir, entry.name)] : [],",
    '  );',
    "for (const file of existsSync('src') ? walk('src') : []) await import(pathToFileURL(resolve(file)).href);",
    '',
  ].join('\n'),
};

export const STACK_LAYERS = {
  database: {
    'db/migrations/001_users.sql': 'CREATE TABLE users (id serial PRIMARY KEY, name text);\n',
    'src/db/users.js': "export const findUsers = () => [{ id: 1, name: 'Ada' }];\n",
    'src/models/user.js': 'export const userName = (user) => user.name;\n',
  },
  api: {
    'src/api/users.js':
      "import { findUsers } from '../db/users.js';\nimport { userName } from '../models/user.js';\n" +
      'export const listUsers = () => findUsers().map(userName);\n',
    'src/routes/index.js': "import { listUsers } from '../api/users.js';\nexport const routes = { '/users': listUsers };\n",
  },
  ui: {
    'src/components/user-list.js': "import { listUsers } from '../api/users.js';\nexport const render = () => listUsers().join(', ');\n",
    'src/pages/index.js': "import { render } from '../components/user-list.js';\nexport default render;\n",
  },
};

/** `.pr-split.yml` text; values are JSON strings, which YAML reads as double-quoted scalars. */
export function configYaml({ validate = {}, ...rest } = {}) {
  const lines = Object.entries(rest).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  const commands = Object.entries(validate);
  if (commands.length > 0) lines.push('validate:', ...commands.map(([name, cmd]) => `  ${name}: ${JSON.stringify(cmd)}`));
  return `${lines.join('\n')}\n`;
}

/** The three-layer project on main, the whole feature in one commit on top. */
export function makeStackRepo(config = {}) {
  return makeRepo({
    base: { ...STACK_BASE, '.pr-split.yml': configYaml(config) },
    feature: { ...STACK_LAYERS.database, ...STACK_LAYERS.api, ...STACK_LAYERS.ui },
  });
}

/** A bare repository added to `repo` as remote `name`. */
export function addBareRemote(repo, name = 'origin') {
  const dir = mkdtempSync(join(tmpdir(), 'pr-split-remote-'));
  git(dir, 'init', '-q', '--bare');
  git(repo.dir, 'remote', 'add', name, dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const FAKE_GH = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url));

/**
 * A fake GitHub behind a `gh` on PATH (see fake-gh.mjs). `env` goes to the CLI; `state()` reads
 * what "GitHub" holds now; `update(fn)` changes it, as a person on github.com would.
 * PR numbers start at 11, so an index (1, 2, 3) can't pass for a PR number.
 */
export function fakeGitHub({ firstNumber = 11, ...initial } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-split-gh-'));
  const file = join(dir, 'state.json');
  const sq = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\nexec ${sq(process.execPath)} ${sq(FAKE_GH)} "$@"\n`);
  chmodSync(join(dir, 'gh'), 0o755);
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const write = (state) => writeFileSync(file, JSON.stringify(state, null, 2));
  write({
    repo: 'acme/shop',
    login: 'you',
    nextNumber: firstNumber,
    nextCommentId: 9001,
    nextStack: 1,
    prs: [],
    stacks: [],
    calls: [],
    ...initial,
  });
  return {
    env: { PATH: `${dir}:${process.env.PATH}`, FAKE_GH_STATE: file },
    state: read,
    update(change) {
      const state = read();
      change(state);
      write(state);
    },
    /** The recorded gh calls, as "pr create", "api POST repos/{owner}/{repo}/stacks", … */
    commands: () => read().calls.map((call) => call.command),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Open PRs on the fake GitHub, bottom of the stack first. */
export const openPrs = (github) => github.state().prs.filter((pr) => pr.state === 'OPEN');

/** Local branch names under refs/heads/<prefix>, sorted. */
export function branches(dir, prefix = 'pr-split/') {
  const out = git(dir, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`);
  return out === '' ? [] : out.split('\n').sort();
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
}

/**
 * Creates a throwaway repo: `main` holds README.md plus `base`, then `featureBranch`
 * renames, removes and writes files on top of it in a single commit.
 */
export function makeRepo({ base = {}, feature = {}, remove = [], rename = [], featureBranch = 'feature/split-me' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-split-test-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'pr-split test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFiles(dir, { 'README.md': '# fixture\n', ...base });
  commitAll(dir, 'base');
  git(dir, 'checkout', '-q', '-b', featureBranch);
  for (const [from, to] of rename) {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    git(dir, 'mv', from, to);
  }
  for (const path of remove) git(dir, 'rm', '-q', path);
  writeFiles(dir, feature);
  commitAll(dir, 'feature');
  return { dir, featureBranch, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A minimal writable stream that keeps what was written. */
export function capture() {
  let text = '';
  return {
    write(chunk) {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}

/** HEAD, branches, status: everything a dry run must leave alone. */
export function snapshot(dir) {
  return {
    head: git(dir, 'rev-parse', 'HEAD'),
    branch: git(dir, 'symbolic-ref', '--short', 'HEAD'),
    refs: git(dir, 'for-each-ref', '--format=%(refname) %(objectname)'),
    status: git(dir, 'status', '--porcelain'),
  };
}

/** Environment for running generated scripts: nothing from the caller beyond PATH and HOME. */
export function scriptEnv(extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
}

/**
 * Local stand-in for Ollama's POST /api/chat. `reply(body)` returns what the "model"
 * answers: an object (sent as JSON text) or a raw string.
 */
export async function startFakeOllama(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(data);
      requests.push({ method: req.method, url: req.url, body });
      const content = reply(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: body.model,
          message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) },
          done: true,
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    host: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
