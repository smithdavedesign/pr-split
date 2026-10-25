// Runs the GitHub CLI, always with an argv array (never a shell); with git.js and execute.js, one
// of the three modules that start processes. gh holds the GitHub login, so pr-split never sees a
// token. Bodies go over stdin, which keeps them out of the process list.
import { spawn } from 'node:child_process';
import { usageError } from './errors.js';

/** A stuck network call must not hang the run. */
export const GH_TIMEOUT_MS = 120_000;
/** The REST API version that has stacked pull requests (public preview since 2026-07-30). */
export const STACKS_API_VERSION = '2026-03-10';
/** How many open PRs per head branch to look at; more than one only happens with forks or other bases. */
const LIST_LIMIT = 50;
/** pr-split's stack-map comment is posted right after the PR is opened, so it's on the first page. */
const COMMENTS_PAGE = 100;

const firstLine = (text) => text.trim().split('\n')[0].replace(/[\u0000-\u001f\u007f]/g, ' ');

/**
 * Runs `gh <args>` and resolves with its stdout. `input` is written to its stdin; without it, stdin
 * is closed. Rejects with gh's first line of stderr, or an error with code ENOENT if gh is missing.
 */
export function gh(args, { cwd, env, input, timeoutMs = GH_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      cwd,
      env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code !== 'ENOENT') return reject(err);
      reject(Object.assign(new Error('gh (the GitHub CLI) is not installed or not on PATH'), { code: 'ENOENT' }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      const reason = timedOut
        ? `no answer within ${timeoutMs / 1000}s`
        : firstLine(stderr) || (signal ? `stopped by ${signal}` : `exit code ${code}`);
      reject(new Error(`gh ${args[0]} ${args[0] === 'api' ? 'call' : args[1]} failed: ${reason}`));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Fails with exit 2 before anything is built if gh is missing or not logged in. */
export async function assertGh({ cwd, env }) {
  try {
    await gh(['auth', 'status'], { cwd, env });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw usageError('--pr needs the GitHub CLI (gh): install it from https://cli.github.com, then run gh auth login');
    }
    throw usageError(`gh is not logged in to GitHub (${err.message}); run gh auth login, then try again`);
  }
}

const parseJson = (text, what) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`gh returned something that is not JSON for ${what}`);
  }
};

/**
 * The GitHub operations pr-split needs, for the repository gh resolves from `cwd`'s remotes.
 * Pull requests are always from this repository: a fork's PR from a branch with the same name is
 * never picked up.
 */
export function githubClient({ cwd, env, timeoutMs }) {
  const run = (args, input) => gh(args, { cwd, env, input, timeoutMs });
  const api = async (method, endpoint, { payload, stacks = false } = {}) => {
    const args = ['api', '--method', method];
    if (stacks) args.push('--header', `X-GitHub-Api-Version: ${STACKS_API_VERSION}`);
    args.push(endpoint);
    if (payload !== undefined) args.push('--input', '-');
    const out = await run(args, payload === undefined ? undefined : JSON.stringify(payload));
    return parseJson(out, endpoint);
  };

  return {
    /** The open, same-repository PR from `head`, preferring one into `base`; null if there is none. */
    async findPullRequest(head, base) {
      const fields = 'number,url,baseRefName,headRefName,body,isCrossRepository';
      const out = await run(['pr', 'list', '--head', head, '--state', 'open', '--json', fields, '--limit', String(LIST_LIMIT)]);
      const prs = parseJson(out, `the PRs of ${head}`).filter((pr) => pr.isCrossRepository === false && pr.headRefName === head);
      const pr = prs.find((p) => p.baseRefName === base) ?? prs[0];
      return pr ? { number: pr.number, url: pr.url, base: pr.baseRefName, body: pr.body ?? '' } : null;
    },

    async createPullRequest({ head, base, title, body }) {
      const out = await run(['pr', 'create', '--head', head, '--base', base, '--title', title, '--body-file', '-'], body);
      const url = out.trim().split('\n').at(-1);
      const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
      if (!number) throw new Error(`gh pr create didn't print the new PR's URL (got ${JSON.stringify(firstLine(out))})`);
      return { number, url };
    },

    /** Changes the base and/or the body; the title is the author's once the PR exists. */
    async editPullRequest(number, { base, body }) {
      const args = ['pr', 'edit', String(number)];
      if (base !== undefined) args.push('--base', base);
      if (body !== undefined) args.push('--body-file', '-');
      await run(args, body);
    },

    /**
     * Creates or edits the comment on PR `number` whose body starts with `marker`.
     * @returns {Promise<'posted' | 'updated' | 'unchanged'>}
     */
    async upsertComment(number, marker, body) {
      const comments = await api('GET', `repos/{owner}/{repo}/issues/${number}/comments?per_page=${COMMENTS_PAGE}`);
      const ours = Array.isArray(comments) ? comments.find((c) => typeof c?.body === 'string' && c.body.startsWith(marker)) : undefined;
      if (!ours) {
        await api('POST', `repos/{owner}/{repo}/issues/${number}/comments`, { payload: { body } });
        return 'posted';
      }
      if (sameText(ours.body, body)) return 'unchanged';
      await api('PATCH', `repos/{owner}/{repo}/issues/comments/${ours.id}`, { payload: { body } });
      return 'updated';
    },

    /** The native stack PR `number` belongs to (GitHub's `stack` object), or null. */
    async stackOf(number) {
      const pr = await api('GET', `repos/{owner}/{repo}/pulls/${number}`, { stacks: true });
      return pr?.stack ?? null;
    },

    /** Links the PRs, bottom to top, as a native GitHub stack. */
    async createStack(numbers) {
      return api('POST', 'repos/{owner}/{repo}/stacks', { payload: { pull_requests: numbers }, stacks: true });
    },
  };
}

/** GitHub stores text edited on the website with CRLF line endings. */
export const sameText = (a, b) => String(a ?? '').replaceAll('\r\n', '\n') === String(b ?? '').replaceAll('\r\n', '\n');
