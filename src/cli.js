import { chmodSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { heuristicGroups } from './categorize.js';
import { MAX_RETRIES, isRetryCount, loadConfig } from './config.js';
import { usageError } from './errors.js';
import { runScript } from './execute.js';
import {
  assertRemote,
  branchName,
  excludeLocally,
  findStack,
  getChanges,
  pushBranches,
  readStack,
  refName,
  repoRoot,
} from './git.js';
import { assertGh, githubClient } from './github.js';
import { DEFAULT_MODEL, normalizeGroups, ollamaGroups } from './llm.js';
import { BRANCH_PREFIX, buildPlan, formatSummary } from './plan.js';
import { PullRequestError, syncPullRequests } from './pr.js';
import { renderScript } from './script.js';

const { version } = createRequire(import.meta.url)('../package.json');

const DEFAULT_BASE = 'main';
const DEFAULT_SCRIPT = 'pr-split.sh';
const DEFAULT_REMOTE = 'origin';
const MAX_ISSUE_LENGTH = 200;

const HELP = `Usage: pr-split [--base <branch>] [--feature <branch>] [options]

Plans how to split a feature branch into a stack of small PRs and writes a bash
script that builds the stack. By default that's a dry run and your repository is
not changed; --execute runs the script: one branch per layer, each validated.
--execute --pr then opens the stack on GitHub as pull requests.

Options:
  --base <branch>     branch the PR targets (default: "base" in .pr-split.yml, else ${DEFAULT_BASE})
  --feature <branch>  branch to split (default: the current branch)
  --config <file>     config file (default: .pr-split.yml at the repo root)
  --script <file>     where to write the script (default: ${DEFAULT_SCRIPT})
  --model <name>      Ollama model (default: "model" in .pr-split.yml, else ${DEFAULT_MODEL})
  --no-llm            group by file paths only, without Ollama
  --json              print the plan as JSON instead of a summary
  --dry-run           preview only (the default): nothing is executed
  --execute           run the script: create the branches and validate each one,
                      stopping at the first failure (needs a clean working tree)
  --retries <n>       retry a failing validation command n times (default: "retries"
                      in .pr-split.yml, else 0; at most ${MAX_RETRIES})
  --issue <ref>       add "Refs: <ref>" to every commit (123, #123, ABC-42, a URL)
  --push              push the branches once every layer passed (--force-with-lease)
  --remote <name>     remote for --push and --pr (default: ${DEFAULT_REMOTE})
  --force             overwrite pr-split/* branches pr-split didn't make for this feature
  --pr                after --execute, push the stack and open one PR per layer with gh,
                      each based on the one below it, linked as a GitHub stack; a re-run
                      updates those PRs (implies --push)
  --pr-only           skip building: push the stack pr-split already built for this
                      feature and open or update its PRs
  -h, --help          show this help
  -v, --version       show the version

Grouping uses a local Ollama server at $OLLAMA_HOST (default 127.0.0.1:11434).
If it can't be reached, files are grouped by their paths instead.
--pr and --pr-only need the GitHub CLI, logged in (gh auth login).
Exit codes: 0 ok, 1 failure (including a layer that failed validation), 2 bad usage.
`;

const OPTIONS = {
  base: { type: 'string' },
  feature: { type: 'string' },
  config: { type: 'string' },
  script: { type: 'string' },
  model: { type: 'string' },
  'no-llm': { type: 'boolean' },
  json: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  execute: { type: 'boolean' },
  retries: { type: 'string' },
  issue: { type: 'string' },
  push: { type: 'boolean' },
  remote: { type: 'string' },
  force: { type: 'boolean' },
  pr: { type: 'boolean' },
  'pr-only': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

function parseRetries(value) {
  const count = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!isRetryCount(count)) throw usageError(`--retries must be a whole number from 0 to ${MAX_RETRIES}`);
  return count;
}

/** The issue for the commits' `Refs:` trailer. A bare number means a GitHub issue: 123 → #123. */
function parseIssue(value) {
  const issue = value.trim();
  if (issue === '' || issue.startsWith('-') || issue.length > MAX_ISSUE_LENGTH || /[\u0000-\u001f\u007f]/.test(issue)) {
    throw usageError(`invalid --issue ${JSON.stringify(value)} (use something like 123, #123, ABC-42 or an issue URL)`);
  }
  return /^\d+$/.test(issue) ? `#${issue}` : issue;
}

/** The branch the bottom PR targets: a PR can't target a tag or a commit. */
async function prBase(cwd, base) {
  const name = await branchName({ cwd, ref: base });
  if (!name) throw usageError(`--pr needs --base to be a branch (a local or remote-tracking one), not "${base}"`);
  return name;
}

/**
 * Opens or updates the PRs of the stack on `branches`, reporting each step on stderr. A failure
 * halfway is reported with what exists so far, and returned as `pullRequestError`.
 */
async function pullRequestStep({ root, env, stderr, feature, base, branches, checks }) {
  const log = (line) => stderr.write(`pr-split: ${line}\n`);
  const layers = await readStack({ cwd: root, feature, base, branches });
  try {
    return await syncPullRequests({ layers, feature, base, checks, github: githubClient({ cwd: root, env }), log });
  } catch (err) {
    if (!(err instanceof PullRequestError)) throw err;
    log(err.message);
    log(
      `opened so far: ${err.pullRequests.map((p) => `#${p.number}`).join(' ') || 'none'}. ` +
        'Fix the problem, then run pr-split --pr-only to finish: it reuses the PRs that exist.',
    );
    return { pullRequests: err.pullRequests, pullRequestError: err.message };
  }
}

/** --pr-only: no plan and no script; push the stack pr-split built earlier and open its PRs. */
async function prOnly({ args, config, cwd, root, env, stdout, stderr, remote }) {
  const feature = await refName({ cwd, ref: args.feature ?? 'HEAD' });
  const baseRef = args.base ?? config.base ?? DEFAULT_BASE;
  await refName({ cwd, ref: baseRef, label: 'base' });
  const base = await prBase(cwd, baseRef);
  const branches = await findStack({ cwd: root, feature, prefix: BRANCH_PREFIX });
  await assertGh({ cwd: root, env });
  await pushBranches({ cwd: root, remote, branches });
  stderr.write(`pr-split: pushed ${branches.length} branch${branches.length === 1 ? '' : 'es'} to ${remote}\n`);
  const result = await pullRequestStep({ root, env, stderr, feature, base, branches, checks: null });
  if (args.json) stdout.write(`${JSON.stringify({ feature, base, remote, branches, ...result }, null, 2)}\n`);
  return result.pullRequestError ? 1 : 0;
}

/**
 * Runs the CLI and returns its exit code: 0 ok, 1 failure, 2 bad usage.
 * Everything it touches is injectable, so tests run it in-process.
 */
export async function main(
  argv,
  { cwd = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = globalThis.fetch, timeoutMs } = {},
) {
  let args;
  try {
    ({ values: args } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    stderr.write(`pr-split: ${err.message}\nRun pr-split --help for usage.\n`);
    return 2;
  }
  if (args.help) {
    stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    stdout.write(`${version}\n`);
    return 0;
  }

  try {
    if (args.execute && args['dry-run']) throw usageError("--execute and --dry-run can't be combined");
    if (args['pr-only'] && (args.execute || args['dry-run'])) {
      throw usageError("--pr-only opens PRs for a stack that's already built, so it can't be combined with --execute or --dry-run");
    }
    // A PR needs its branch on GitHub, so --pr pushes.
    const pr = Boolean(args.pr || args['pr-only']);
    if (args.remote !== undefined && !args.push && !pr) throw usageError('--remote only applies with --push or --pr');
    const retries = args.retries === undefined ? undefined : parseRetries(args.retries);
    const issue = args.issue === undefined ? null : parseIssue(args.issue);
    const root = await repoRoot(cwd);
    const config = loadConfig({ root, path: args.config && resolve(cwd, args.config) });
    const push = args.push || pr ? (args.remote ?? DEFAULT_REMOTE) : null;
    if (push) await assertRemote({ cwd, remote: push });
    if (args['pr-only']) return await prOnly({ args, config, cwd, root, env, stdout, stderr, remote: push });

    const { baseRef, featureRef, mergeBase, featureSha, files } = await getChanges({
      cwd,
      base: args.base ?? config.base ?? DEFAULT_BASE,
      feature: args.feature ?? 'HEAD',
    });
    if (files.length === 0) {
      stderr.write(`pr-split: nothing to split: ${featureRef} has no changes against ${baseRef}\n`);
      return 1;
    }
    // Everything --pr needs is checked before anything is built.
    const prTarget = pr ? await prBase(cwd, baseRef) : null;
    if (pr && args.execute) await assertGh({ cwd: root, env });

    const warnings = [];
    let groups;
    let source = 'heuristic';
    let model = null;
    if (!args['no-llm']) {
      const requested = args.model ?? config.model ?? DEFAULT_MODEL;
      try {
        const raw = await ollamaGroups({ files, model: requested, host: env.OLLAMA_HOST, fetchImpl, timeoutMs });
        const result = normalizeGroups(raw, files);
        groups = result.groups;
        warnings.push(...result.warnings);
        source = 'ollama';
        model = requested;
      } catch (err) {
        warnings.push(
          `couldn't group with Ollama (${err.message}); grouped by file paths instead. Pass --no-llm to skip Ollama.`,
        );
      }
    }
    groups ??= heuristicGroups(files);
    if (args.execute && config.validate.length === 0) {
      warnings.push(
        '--execute without validation commands: the branches are created, but nothing checks that each one builds (add "validate:" to .pr-split.yml)',
      );
    }

    const plan = buildPlan({
      base: baseRef,
      feature: featureRef,
      mergeBase,
      featureSha,
      groups,
      validate: config.validate,
      source,
      model,
      warnings,
      retries: retries ?? config.retries ?? 0,
      issue,
      push,
      force: Boolean(args.force),
      pr,
    });
    const scriptPath = resolve(cwd, args.script ?? DEFAULT_SCRIPT);
    writeFileSync(scriptPath, renderScript(plan));
    chmodSync(scriptPath, 0o755);
    // Otherwise `git add -A` commits it, and the next run sees a dirty tree and its own script in the diff.
    await excludeLocally({ root, file: scriptPath });
    const shownPath = relative(cwd, scriptPath) || scriptPath;

    for (const warning of warnings) stderr.write(`pr-split: warning: ${warning}\n`);
    if (!args.execute) {
      if (args.json) stdout.write(`${JSON.stringify({ ...plan, script: scriptPath }, null, 2)}\n`);
      else stdout.write(formatSummary(plan, shownPath));
      return 0;
    }

    // --execute: show the plan first, then run the very script a dry run would have written.
    // With --json, stdout stays pure JSON and the script's output goes to stderr.
    if (!args.json) stdout.write(`${formatSummary(plan, shownPath, { execute: true })}\n`);
    const exitCode = await runScript({ scriptPath, cwd: root, env, stdout: args.json ? stderr : stdout, stderr });
    // --pr: the script pushed the stack only if every layer passed; now open it as PRs.
    const prs =
      exitCode === 0 && pr
        ? await pullRequestStep({
            root,
            env,
            stderr,
            feature: plan.feature,
            base: prTarget,
            branches: plan.groups.map((g) => g.branch),
            checks: plan.validate.map((v) => v.name),
          })
        : {};
    if (args.json) {
      const execution = { ok: exitCode === 0, exitCode };
      stdout.write(`${JSON.stringify({ ...plan, script: scriptPath, execution, ...prs }, null, 2)}\n`);
    }
    return exitCode === 0 && !prs.pullRequestError ? 0 : 1;
  } catch (err) {
    stderr.write(`pr-split: ${err.message}\n`);
    return err.code === 'USAGE' ? 2 : 1;
  }
}
