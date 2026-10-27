// npm run screenshots: runs pr-split for real on a sample repository and screenshots the result.
// pr-split is a CLI, so the "app" here is a small local web server showing (1) the plan a dry run
// prints, (2) the output of `--execute --pr`, and (3) the pull request it opened, rendered from the
// GitHub stand-in the tests use (test/fake-gh.mjs; there is no network in the build sandbox).
// Chromium comes from $CHROMIUM_PATH; no browser is downloaded. Writes docs/screenshots/*.png.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { chromium, devices } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin/pr-split.js');
const FAKE_GH = join(ROOT, 'test/fake-gh.mjs');
const OUT = join(ROOT, 'docs/screenshots');
const PLAN_ARGS = ['--base', 'main', '--pr', '--issue', '42', '--no-llm'];
const RUN_ARGS = ['--base', 'main', '--execute', '--pr', '--issue', '42', '--no-llm'];

if (!process.env.CHROMIUM_PATH) {
  console.error('screenshots: set CHROMIUM_PATH to a Chromium binary (no browser is downloaded)');
  process.exit(1);
}

// --- A sample shop with a feature branch that touches data, API, UI and docs ------------------

const BASE = {
  'README.md': '# shop\n\nA small online shop.\n',
  'package.json': '{ "name": "shop", "private": true, "type": "module" }\n',
  '.pr-split.yml': 'base: main\nvalidate:\n  build: node scripts/check.mjs\n  lint: node scripts/lint.mjs\n',
  'scripts/check.mjs': [
    '// Loads every module under src/, so a layer that needs code from a later layer fails.',
    "import { readdirSync } from 'node:fs';",
    "import { join, resolve } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    'const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>',
    "  e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []);",
    "for (const file of walk('src')) await import(pathToFileURL(resolve(file)).href);",
    '',
  ].join('\n'),
  'scripts/lint.mjs': [
    "import { readFileSync, readdirSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>',
    '  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);',
    "const bad = walk('src').filter((f) => /\\bdebugger\\b/.test(readFileSync(f, 'utf8')));",
    "if (bad.length) { console.error('debugger left in', bad); process.exit(1); }",
    '',
  ].join('\n'),
  'src/db/connection.js': 'export const db = { orders: [], events: [] };\n',
  'src/api/health.js': "export const health = () => 'ok';\n",
};

const FEATURE = {
  'db/migrations/004_order_events.sql':
    'CREATE TABLE order_events (\n  id serial PRIMARY KEY,\n  order_id int NOT NULL REFERENCES orders (id),\n' +
    '  status text NOT NULL,\n  created_at timestamptz NOT NULL DEFAULT now()\n);\n' +
    'CREATE INDEX order_events_order_id ON order_events (order_id, created_at);\n',
  'src/models/order-event.js':
    "export const STATUSES = ['placed', 'paid', 'shipped', 'delivered'];\n" +
    'export const label = (event) => `${event.status} on ${event.date}`;\n',
  'src/db/order-events.js':
    "import { db } from './connection.js';\n" +
    'export const eventsFor = (orderId) => db.events.filter((e) => e.orderId === orderId);\n' +
    'export const addEvent = (event) => db.events.push(event);\n',
  'src/api/orders.js':
    "import { eventsFor } from '../db/order-events.js';\nimport { label } from '../models/order-event.js';\n" +
    'export const orderHistory = (orderId) => eventsFor(orderId).map(label);\n',
  'src/routes/orders.js':
    "import { orderHistory } from '../api/orders.js';\n" +
    "export const routes = { 'GET /orders/:id/history': (req) => orderHistory(Number(req.params.id)) };\n",
  'src/api/health.js': "export const health = () => ({ status: 'ok', features: ['order-history'] });\n",
  'src/components/order-history.js':
    "import { orderHistory } from '../api/orders.js';\n" +
    "export const OrderHistory = ({ orderId }) => `<ol>${orderHistory(orderId).map((l) => `<li>${l}</li>`).join('')}</ol>`;\n",
  'src/pages/order.js':
    "import { OrderHistory } from '../components/order-history.js';\n" +
    'export default ({ order }) => `<h1>Order ${order.id}</h1>${OrderHistory({ orderId: order.id })}`;\n',
  'docs/order-history.md':
    '# Order history\n\nCustomers can see every status change of an order.\n\n`GET /orders/:id/history` returns the labels, oldest first.\n',
};

const sh = (text) => `'${text.replaceAll("'", "'\\''")}'`;
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const work = mkdtempSync(join(tmpdir(), 'pr-split-screens-'));
const repo = join(work, 'shop');
const remote = join(work, 'shop.git');
const bin = join(work, 'bin');
const state = join(work, 'github.json');
mkdirSync(repo);
mkdirSync(bin);
git(work, 'init', '-q', '--bare', remote);
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.name', 'Shop Developer');
git(repo, 'config', 'user.email', 'dev@shop.example');
git(repo, 'config', 'commit.gpgsign', 'false');
write(repo, BASE);
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'Shop basics');
git(repo, 'remote', 'add', 'origin', remote);
git(repo, 'push', '-q', 'origin', 'main');
git(repo, 'checkout', '-q', '-b', 'feature/order-history');
write(repo, FEATURE);
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'Order history: events table, API, page and docs');

writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(FAKE_GH)} "$@"\n`);
chmodSync(join(bin, 'gh'), 0o755);
writeFileSync(
  state,
  JSON.stringify({ repo: 'acme/shop', login: 'shop-dev', nextNumber: 128, nextCommentId: 1, nextStack: 7, prs: [], stacks: [], calls: [] }),
);
const env = { PATH: `${bin}:${process.env.PATH}`, HOME: work, FAKE_GH_STATE: state };

/** Runs pr-split in the sample repo like a terminal would show it: stdout and stderr interleaved. */
function prSplit(args) {
  const result = spawnSync('bash', ['-c', `exec ${sh(process.execPath)} ${sh(BIN)} ${args.map(sh).join(' ')} 2>&1`], {
    cwd: repo,
    env,
    encoding: 'utf8',
  });
  return { command: `pr-split ${args.join(' ')}`, output: result.stdout.replaceAll(work, '/tmp'), status: result.status };
}

const plan = prSplit(PLAN_ARGS);
const run = prSplit(RUN_ARGS);
if (plan.status !== 0 || run.status !== 0) {
  console.error(plan.output, run.output);
  throw new Error(`pr-split failed (exit ${plan.status} / ${run.status})`);
}
const github = JSON.parse(readFileSync(state, 'utf8'));
const pr = github.prs[1];
if (!pr || github.prs.length !== 4) throw new Error(`expected 4 PRs, got ${github.prs.length}`);

// --- Pages --------------------------------------------------------------------------------------

const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2328; background: #f6f8fa; }
  .bar { background: #24292f; color: #fff; padding: 10px 20px; font-size: 13px; }
  .bar b { color: #7ee787; }
  main { max-width: 1180px; margin: 0 auto; padding: 18px 20px 40px; }
  h1 { font-size: 22px; margin: 4px 0 6px; }
  .note { color: #59636e; font-size: 13px; margin: 0 0 12px; }
  .term { background: #0d1117; color: #e6edf3; border-radius: 8px; padding: 14px 16px; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
  .term .cmd { color: #7ee787; font-weight: 600; }
  .term .dim { color: #8b949e; }
  .term .ok { color: #7ee787; }
  .term .pr { color: #79c0ff; font-weight: 600; }
  .term .warn { color: #d29922; }
  .pr-head .num { color: #59636e; font-weight: 400; }
  .state { display: inline-block; background: #1f883d; color: #fff; border-radius: 2em; padding: 3px 12px; font-size: 13px; font-weight: 600; margin-right: 8px; }
  code { font: 85% ui-monospace, SFMono-Regular, Menlo, monospace; background: #eff1f3; border-radius: 6px; padding: .15em .4em; }
  .branch { color: #0969da; background: #ddf4ff; }
  .box { background: #fff; border: 1px solid #d1d9e0; border-radius: 6px; margin: 14px 0; }
  .box > header { background: #f6f8fa; border-bottom: 1px solid #d1d9e0; padding: 8px 14px; font-size: 13px; color: #59636e; border-radius: 6px 6px 0 0; }
  .md { padding: 4px 16px 12px; overflow-x: auto; }
  .md h2 { font-size: 18px; border-bottom: 1px solid #d1d9e0; padding-bottom: 4px; margin: 18px 0 10px; }
  .md h3 { font-size: 16px; }
  .md table { border-collapse: collapse; font-size: 13px; }
  .md th, .md td { border: 1px solid #d1d9e0; padding: 4px 10px; }
  .md tr:nth-child(2n) td { background: #f6f8fa; }
  .md a { color: #0969da; text-decoration: none; }
  .cols { display: grid; grid-template-columns: 7fr 5fr; gap: 16px; align-items: start; }
  .cols .box { margin-top: 0; }
  @media (max-width: 900px) { .cols { display: block; } }
  @media (max-width: 600px) {
    body { font-size: 14px; }
    main { padding: 12px 10px 30px; }
    .term { font-size: 10.5px; padding: 10px; }
    h1 { font-size: 19px; }
  }`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style></head><body>
<div class="bar"><b>pr-split</b> · sample repo <code style="background:#30363d;color:#e6edf3">acme/shop</code> · GitHub here is the local <code style="background:#30363d;color:#e6edf3">gh</code> stand-in from the test suite</div>
<main>${body}</main></body></html>`;
}

function terminal({ command, output }) {
  const lines = output.trimEnd().split('\n').map((line) => {
    const text = escape(line);
    if (/^pr-split: (opened|updated) #/.test(line)) return `<span class="pr">${text}</span>`;
    if (/^pr-split: (linked|stack map|\d+ stacked PRs|pushed|created|.* passed validation)/.test(line)) return `<span class="ok">${text}</span>`;
    if (/^pr-split: warning/.test(line)) return `<span class="warn">${text}</span>`;
    if (/^(\+ |To |   [0-9a-f]|branch '| \* |\[pr-split)/.test(line)) return `<span class="dim">${text}</span>`;
    return text;
  });
  return `<div class="term" id="term"><span class="cmd">$ ${escape(command)}</span>\n${lines.join('\n')}</div>`;
}

const linkRefs = (html) => html.replace(/(^|[\s(>])#(\d+)\b/g, '$1<a href="#">#$2</a>');
const pages = {
  '/plan': page(
    'pr-split: the plan',
    `<h1>1. The plan (dry run)</h1><p class="note">Run on the 9-file branch <code>feature/order-history</code>. Nothing is changed yet; it writes <code>pr-split.sh</code> and shows what <code>--execute --pr</code> will do.</p>${terminal(plan)}`,
  ),
  '/run': page(
    'pr-split: execute and open the PRs',
    `<h1>2. Build, validate, push, open the stacked PRs</h1><p class="note">Each layer is built on the one below it and must pass <code>build</code> and <code>lint</code> before anything is pushed or opened.</p>${terminal(run)}`,
  ),
  '/pr': page(
    `${pr.title} #${pr.number}`,
    `<div class="pr-head"><h1>${escape(pr.title)} <span class="num">#${pr.number}</span></h1>
<p><span class="state">Open</span><b>shop-dev</b> wants to merge 1 commit into <code class="branch">${escape(pr.baseRefName)}</code> from <code class="branch">${escape(pr.headRefName)}</code> · stack ${pr.stack.number}, PR ${pr.stack.position} of ${pr.stack.size}</p></div>
<div class="cols"><div class="box"><header><b>shop-dev</b> opened this pull request (description written by pr-split)</header><div class="md">${linkRefs(marked.parse(pr.body))}</div></div>
<div class="box"><header><b>shop-dev</b> commented (stack map, kept up to date by pr-split)</header><div class="md">${linkRefs(marked.parse(pr.comments[0].body))}</div></div></div>`,
  ),
};

// --- Serve, screenshot, stop ---------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const html = pages[req.url];
  res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html ?? 'not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${origin}/plan`)).ok) break;
  } catch (err) {
    if (i > 50) throw err;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const SHOTS = [
  { path: '/plan', name: 'plan', scroll: 'top' },
  { path: '/run', name: 'execute-pr', scroll: 'bottom' },
  { path: '/pr', name: 'pull-request', scroll: 'top' },
];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
  mkdirSync(OUT, { recursive: true });
  for (const [size, options] of [
    ['desktop', { viewport: { width: 1280, height: 800 } }],
    ['mobile', devices['iPhone 13']],
  ]) {
    const context = await browser.newContext(options);
    const tab = await context.newPage();
    for (const shot of SHOTS) {
      await tab.goto(`${origin}${shot.path}`, { waitUntil: 'load' });
      if (shot.scroll === 'bottom') await tab.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const file = join(OUT, `${shot.name}-${size}.png`);
      await tab.screenshot({ path: file });
      console.log(`screenshots: ${file.slice(ROOT.length)}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(work, { recursive: true, force: true });
}
