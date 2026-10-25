// A stand-in for the GitHub CLI, for tests and the screenshots: "GitHub" (pull requests, comments,
// stacks) lives in the JSON file $FAKE_GH_STATE, and every call is recorded there. It answers the
// gh commands pr-split uses, and like GitHub it only accepts a PR whose head and base branches
// exist on the remote ($FAKE_GH_REMOTE, default origin, a local bare repository).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const STATE = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(STATE, 'utf8'));
const args = process.argv.slice(2);
const input = args.includes('-') ? readFileSync(0, 'utf8') : undefined;
state.calls.push({ args, ...(input === undefined ? {} : { input }) });

const save = () => writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
function finish(code, out = '', err = '') {
  save();
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exit(code);
}

/** `--name value` pairs and positional arguments (pr-split only uses long flags). */
function parse(list) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith('--')) flags[list[i].slice(2)] = list[++i];
    else positional.push(list[i]);
  }
  return { flags, positional };
}

const { flags, positional } = parse(args.slice(args[0] === 'api' ? 1 : 2));
const method = (flags.method ?? 'GET').toUpperCase();
const command = args[0] === 'api' ? `api ${method} ${positional[0]}` : args.slice(0, 2).join(' ');

// Failure injection: { "pr create": 2 } fails the second `gh pr create`.
const nth = state.calls.filter((call) => call.command === command).length + 1;
state.calls.at(-1).command = command;
if (state.failOn?.[command] === nth) finish(1, '', 'HTTP 502: Bad Gateway (https://api.github.com/graphql)\n');

const repoUrl = `https://github.com/${state.repo}`;
const remoteHas = (branch) => {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', process.env.FAKE_GH_REMOTE ?? 'origin'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const findPr = (number) => state.prs.find((pr) => pr.number === Number(number));
const pick = (pr, fields) => Object.fromEntries(fields.map((f) => [f, pr[f]]));
const apiError = (status, message) => finish(1, `${JSON.stringify({ message })}\n`, `gh: ${message} (HTTP ${status})\n`);

if (command === 'auth status') {
  if (state.loggedOut) finish(1, '', 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n');
  finish(0, '', `github.com\n  ✓ Logged in to github.com account ${state.login}\n`);
}

if (command === 'pr list') {
  const fields = flags.json.split(',');
  const found = state.prs.filter((pr) => pr.headRefName === flags.head && (flags.state !== 'open' || pr.state === 'OPEN'));
  finish(0, `${JSON.stringify(found.slice(0, Number(flags.limit ?? 30)).map((pr) => pick(pr, fields)))}\n`);
}

if (command === 'pr create') {
  const { head, base, title } = flags;
  if (!remoteHas(head) || !remoteHas(base)) {
    finish(1, '', 'pull request create failed: GraphQL: Head sha can\'t be blank, Base sha can\'t be blank, Head ref must be a branch (createPullRequest)\n');
  }
  const open = state.prs.find((pr) => pr.state === 'OPEN' && !pr.isCrossRepository && pr.headRefName === head && pr.baseRefName === base);
  if (open) finish(1, '', `a pull request for branch "${head}" into branch "${base}" already exists:\n${open.url}\n`);
  const number = state.nextNumber++;
  const pr = {
    number,
    url: `${repoUrl}/pull/${number}`,
    title,
    body: input,
    headRefName: head,
    baseRefName: base,
    state: 'OPEN',
    isCrossRepository: false,
    comments: [],
    stack: null,
  };
  state.prs.push(pr);
  finish(0, `${pr.url}\n`);
}

if (command === 'pr edit') {
  const pr = findPr(positional[0]);
  if (!pr) finish(1, '', `GraphQL: Could not resolve to a PullRequest with the number of ${positional[0]}.\n`);
  if (flags.base !== undefined && flags.base !== pr.baseRefName) {
    if (pr.stack) finish(1, '', 'GraphQL: Cannot change the base branch because the pull request is part of a stack. (updatePullRequest)\n');
    if (!remoteHas(flags.base)) finish(1, '', 'GraphQL: Proposed base branch was not found (updatePullRequest)\n');
    pr.baseRefName = flags.base;
  }
  if (flags['body-file'] !== undefined) pr.body = input;
  if (flags.title !== undefined) pr.title = flags.title;
  finish(0, `${pr.url}\n`);
}

if (args[0] === 'api') {
  const endpoint = command.split(' ')[2].replace('repos/{owner}/{repo}/', '');
  const payload = input === undefined ? undefined : JSON.parse(input);
  let match;
  if (state.stacksUnsupported && /^(stacks|pulls\/\d+)/.test(endpoint)) apiError(404, 'Not Found');
  if ((match = /^issues\/(\d+)\/comments(?:\?per_page=(\d+))?$/.exec(endpoint))) {
    const pr = findPr(match[1]);
    if (!pr) apiError(404, 'Not Found');
    if (method === 'GET') finish(0, `${JSON.stringify(pr.comments.slice(0, Number(match[2] ?? 30)))}\n`);
    const comment = { id: state.nextCommentId++, body: payload.body, user: { login: state.login } };
    pr.comments.push(comment);
    finish(0, `${JSON.stringify(comment)}\n`);
  }
  if ((match = /^issues\/comments\/(\d+)$/.exec(endpoint)) && method === 'PATCH') {
    const comment = state.prs.flatMap((pr) => pr.comments).find((c) => c.id === Number(match[1]));
    if (!comment) apiError(404, 'Not Found');
    comment.body = payload.body;
    finish(0, `${JSON.stringify(comment)}\n`);
  }
  if ((match = /^pulls\/(\d+)$/.exec(endpoint)) && method === 'GET') {
    const pr = findPr(match[1]);
    if (!pr) apiError(404, 'Not Found');
    finish(0, `${JSON.stringify({ number: pr.number, base: { ref: pr.baseRefName }, head: { ref: pr.headRefName }, stack: pr.stack })}\n`);
  }
  if (endpoint === 'stacks' && method === 'POST') {
    const prs = payload.pull_requests.map(findPr);
    const valid =
      prs.length >= 2 &&
      prs.every((pr, i) => pr && pr.state === 'OPEN' && !pr.stack && (i === 0 || pr.baseRefName === prs[i - 1].headRefName));
    if (!valid) apiError(422, 'Validation Failed');
    const stack = { number: state.nextStack++, pull_requests: payload.pull_requests };
    state.stacks.push(stack);
    prs.forEach((pr, i) => {
      pr.stack = { number: stack.number, size: prs.length, position: i + 1 };
    });
    finish(0, `${JSON.stringify(stack)}\n`);
  }
}

finish(1, '', `fake gh: unsupported command: gh ${args.join(' ')}\n`);
