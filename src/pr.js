// Stacked pull requests (M3): what each PR says, and opening or updating them bottom-up.
// The rendering is pure; syncPullRequests only reaches GitHub through the client it is given
// (github.js in the CLI, an in-memory one in tests).
import { sameText } from './github.js';

/** pr-split owns the text between these markers in a PR body; anything around them is the author's. */
export const BODY_START = '<!-- pr-split:begin -->';
export const BODY_END = '<!-- pr-split:end -->';
/** The stack-map comment starts with this, which is how a re-run finds it again. */
export const STACK_MAP_MARKER = '<!-- pr-split:stack-map -->';
/** GitHub caps a body at 65,536 characters: the file table stops at 100 rows or this many characters. */
export const MAX_BODY_FILES = 100;
const MAX_TABLE_CHARS = 40_000;

const VALIDATED = /<!-- pr-split:validated ([0-9a-f]{40}) ([^\s>]*) -->/g;
const STATUS = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const lines = (layer) => `+${layer.additions} -${layer.deletions}`;
const upperFirst = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);
const ref = (number) => `#${number}`;

/**
 * Text from the model or a commit, shown as plain text: no Markdown, HTML or links, and no
 * @mention or #reference (so "fixes #12" can't close an issue and "@someone" pings nobody).
 */
export function mdText(text) {
  return String(text)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\`*_[\]<>|~]/g, '\\$&')
    .replace(/[@#]/g, `$&${ZERO_WIDTH_SPACE}`);
}

/** A code span that holds `text` literally, whatever backticks it contains. */
export function codeSpan(text) {
  const value = String(text).replace(/[\u0000-\u001f\u007f]/g, ' ');
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** Table cells split on "|", even inside code spans. */
const cell = (text) => text.replaceAll('|', '\\|');

function fileRow(file) {
  const change = file.oldPath ? `${STATUS[file.status]} from ${cell(codeSpan(file.oldPath))}` : STATUS[file.status] ?? file.status;
  return `| ${change} | ${cell(codeSpan(file.path))} | ${file.binary ? 'binary' : `+${file.additions} -${file.deletions}`} |`;
}

// Names come from branch names, which --pr-only takes as it finds them: plain text too.
const layerLine = (layer) => `**${mdText(layer.name)}**${layer.summary ? `: ${mdText(upperFirst(layer.summary))}` : ''}`;

function validationLines(layer, checks) {
  if (checks === null || checks === undefined) {
    return [
      `⚠️ Not validated by this pr-split run: the PR was opened for an existing branch (\`--pr-only\`), so pr-split didn't build or test commit ${codeSpan(layer.sha.slice(0, 7))}. \`pr-split --execute --pr\` validates every layer before opening its PR.`,
    ];
  }
  if (checks.length === 0) {
    return ['⚠️ No validation commands are configured (`validate:` in `.pr-split.yml`), so pr-split did not build or test this layer.'];
  }
  return [
    `<!-- pr-split:validated ${layer.sha} ${checks.map(encodeURIComponent).join(',')} -->`,
    `✅ This commit (${codeSpan(layer.sha.slice(0, 7))}) passed ${checks.map((c) => `**${mdText(c)}**`).join(', ')} before the PR was opened, with only this layer and the ones below it applied.`,
  ];
}

/**
 * pr-split's part of a PR body: a summary of the layer's changes, its dependencies and its
 * validation. `numbers` are the PR numbers of the layers below it (bottom first); `checks` are the
 * validation commands this commit passed ([] if none are configured, null if not validated).
 */
export function prSection(layer, { layers, numbers, feature, base, checks }) {
  const rows = [];
  let size = 0;
  for (const file of layer.files) {
    const row = fileRow(file);
    if (rows.length === MAX_BODY_FILES || size + row.length > MAX_TABLE_CHARS) break;
    rows.push(row);
    size += row.length + 1;
  }
  const out = [
    BODY_START,
    '## Summary',
    '',
    layerLine(layer),
    '',
    `Part ${layer.index} of ${layers.length} of ${codeSpan(feature)}, split into stacked PRs by pr-split. ` +
      `${plural(layer.files.length, 'file')}, ${lines(layer)}:`,
    '',
    '| Change | File | Lines |',
    '| --- | --- | ---: |',
    ...rows,
  ];
  if (layer.files.length > rows.length) out.push('', `…and ${plural(layer.files.length - rows.length, 'more file')}.`);
  if (layer.refs.length > 0) out.push('', ...layer.refs.map((r) => `Refs: ${r}`));
  out.push('', '## Dependencies', '');
  if (layer.index === 1) {
    out.push(`None: this is the bottom of the stack. It targets ${codeSpan(base)} and can be reviewed and merged first.`);
  } else {
    const below = layers.slice(0, layer.index - 1);
    const parent = numbers[layer.index - 2];
    out.push(`Depends on ${ref(parent)}. Merge ${below.length === 1 ? 'it' : 'these'} first, bottom-up:`, '');
    below.forEach((l, i) => out.push(`${i + 1}. ${ref(numbers[i])} ${layerLine(l)} (${plural(l.files.length, 'file')}, ${lines(l)})`));
    out.push(
      '',
      `This PR targets ${codeSpan(layer.parent)}, so its diff shows only this layer. Once ${ref(parent)} is merged, GitHub retargets it to ${codeSpan(base)}.`,
    );
  }
  out.push(
    '',
    '## Validation',
    '',
    ...validationLines(layer, checks),
    '',
    "<sub>Written by pr-split. Running it again rewrites this part of the description; anything you add above or below it is kept.</sub>",
    BODY_END,
  );
  return out.join('\n');
}

/**
 * The checks a previous run recorded in `body` as passed on commit `sha`, or null. Every marker is
 * looked at: the author's text could hold an old copy of the section.
 */
export function validatedChecks(body, sha) {
  for (const match of String(body ?? '').matchAll(VALIDATED)) {
    if (match[1] !== sha) continue;
    try {
      return match[2] === '' ? [] : match[2].split(',').map(decodeURIComponent);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * `existing` with pr-split's section replaced by `section`, keeping the author's text around it.
 * A PR opened by hand keeps its description, with the section added below.
 */
export function mergeBody(existing, section) {
  if (!existing) return section;
  const start = existing.indexOf(BODY_START);
  // The last end marker: a file name in the file table could contain the marker text too.
  const end = existing.lastIndexOf(BODY_END);
  if (start !== -1 && end > start) return existing.slice(0, start) + section + existing.slice(end + BODY_END.length);
  return `${existing.trimEnd()}\n\n${section}`;
}

/** The stack-map comment for the PR of layer `current`: the whole stack, top first, like a stack. */
export function stackMap(layers, { numbers, current, feature, base, nativeStack }) {
  const rows = [...layers].reverse().map((l) => {
    const pr = l.index === current ? `**${ref(numbers[l.index - 1])} · this PR**` : ref(numbers[l.index - 1]);
    return `| ${l.index} | ${pr} | ${mdText(l.name)} | ${l.files.length} | ${lines(l)} |`;
  });
  const out = [
    STACK_MAP_MARKER,
    '### Stack map',
    '',
    `${codeSpan(feature)} was split into ${plural(layers.length, 'stacked PR')} on ${codeSpan(base)}. ` +
      'Each PR is based on the one below it; review and merge them bottom-up.',
    '',
    '|  | PR | Layer | Files | Lines |',
    '| ---: | --- | --- | ---: | ---: |',
    ...rows,
    `|  | ${codeSpan(base)} | base |  |  |`,
    '',
  ];
  if (layers.length < 2) {
    out.push('A split with a single PR has nothing to stack.');
  } else if (nativeStack?.linked) {
    out.push(
      `✅ Linked as a native GitHub stack: GitHub shows the stack on each PR, runs the checks of ${codeSpan(base)} on every PR, and retargets each PR as the ones below it merge.`,
    );
  } else {
    out.push(
      `⚠️ Not linked as a native GitHub stack (${mdText(nativeStack?.reason ?? 'not attempted')}), so checks that only run for PRs into ${codeSpan(base)} may skip the upper PRs. ` +
        `To link them: \`gh stack link ${numbers.join(' ')}\`, or open ${ref(numbers.at(-1))} and choose **Create stack**.`,
    );
  }
  out.push('', '<sub>Kept up to date by pr-split.</sub>');
  return out.join('\n');
}

/**
 * Links the PRs as a native GitHub stack unless they already are one. Never throws: GitHub
 * Enterprise Server has no stacks yet, and an old token may lack the permission.
 * @returns {Promise<{ linked: boolean, created?: boolean, number?: number, reason?: string }>}
 */
export async function linkStack(numbers, github) {
  if (numbers.length < 2) return { linked: false, reason: 'a stack needs at least two PRs' };
  try {
    const stacks = [];
    for (const number of numbers) stacks.push(await github.stackOf(number));
    const inStack = stacks.filter(Boolean);
    const ids = new Set(inStack.map((s) => s.number));
    if (inStack.length === numbers.length && ids.size <= 1) {
      return { linked: true, created: false, ...(inStack[0].number === undefined ? {} : { number: inStack[0].number }) };
    }
    if (inStack.length > 0) {
      const which = numbers.filter((_, i) => stacks[i]).map(ref).join(' ');
      const where = ids.size === 1 && inStack[0].number !== undefined ? `GitHub stack ${inStack[0].number}` : 'other GitHub stacks';
      return { linked: false, reason: `${which} are in ${where} without the rest; add the others with gh stack link` };
    }
    const created = await github.createStack(numbers);
    return { linked: true, created: true, ...(typeof created?.number === 'number' ? { number: created.number } : {}) };
  } catch (err) {
    return { linked: false, reason: err.message };
  }
}

/** Thrown when the PR step stops halfway; `pullRequests` are the ones already opened or updated. */
export class PullRequestError extends Error {
  constructor(message, pullRequests) {
    super(message);
    this.pullRequests = pullRequests;
  }
}

/**
 * Opens or updates one PR per layer, bottom-up, links them as a GitHub stack and posts the stack
 * map on each. Idempotent: a re-run finds each branch's open PR and only changes what differs.
 * @param {{ layers: import('./git.js').StackLayer[], feature: string, base: string,
 *   checks: string[] | null, github: ReturnType<typeof import('./github.js').githubClient>,
 *   log: (line: string) => void }} input
 *   `checks`: the validation commands every layer passed in this run, or null when nothing was
 *   validated (--pr-only), in which case a previous run's record for the same commit is kept.
 */
export async function syncPullRequests({ layers, feature, base, checks, github, log }) {
  const pullRequests = [];
  for (const layer of layers) {
    const numbers = pullRequests.map((p) => p.number);
    let pull;
    let step = `couldn't look up the PR for ${layer.branch}`;
    try {
      const existing = await github.findPullRequest(layer.branch, layer.parent);
      step = existing ? `couldn't update ${ref(existing.number)} for ${layer.branch}` : `couldn't open the PR for ${layer.branch}`;
      const section = prSection(layer, {
        layers,
        numbers,
        feature,
        base,
        checks: checks ?? validatedChecks(existing?.body, layer.sha),
      });
      if (!existing) {
        const created = await github.createPullRequest({ head: layer.branch, base: layer.parent, title: layer.title, body: section });
        pull = { ...created, action: 'opened' };
      } else {
        const body = mergeBody(existing.body, section);
        const changes = {};
        if (existing.base !== layer.parent) changes.base = layer.parent;
        if (!sameText(body, existing.body)) changes.body = body;
        if (Object.keys(changes).length > 0) await github.editPullRequest(existing.number, changes);
        pull = { number: existing.number, url: existing.url, action: Object.keys(changes).length > 0 ? 'updated' : 'unchanged' };
      }
    } catch (err) {
      throw new PullRequestError(`${step}: ${err.message}`, pullRequests);
    }
    pullRequests.push({ number: pull.number, url: pull.url, branch: layer.branch, base: layer.parent, action: pull.action });
    log(
      pull.action === 'unchanged'
        ? `${ref(pull.number)} ${layer.branch} is up to date: ${pull.url}`
        : `${pull.action} ${ref(pull.number)} ${layer.branch} → ${layer.parent}: ${pull.url}`,
    );
  }

  const numbers = pullRequests.map((p) => p.number);
  const all = numbers.map(ref).join(' ');
  const nativeStack = await linkStack(numbers, github);
  if (nativeStack.linked) {
    const name = nativeStack.number === undefined ? 'a GitHub stack' : `GitHub stack ${nativeStack.number}`;
    log(nativeStack.created ? `linked ${all} as ${name}` : `${all} are already ${name}`);
  } else if (numbers.length > 1) {
    log(
      `warning: couldn't link ${all} as a GitHub stack (${nativeStack.reason}); ` +
        `link them with gh stack link ${numbers.join(' ')}, or choose Create stack on ${ref(numbers.at(-1))}`,
    );
  }

  const comments = { posted: [], updated: [], unchanged: [] };
  for (const layer of layers) {
    const number = numbers[layer.index - 1];
    const body = stackMap(layers, { numbers, current: layer.index, feature, base, nativeStack });
    try {
      comments[await github.upsertComment(number, STACK_MAP_MARKER, body)].push(ref(number));
    } catch (err) {
      throw new PullRequestError(`couldn't post the stack map on ${ref(number)}: ${err.message}`, pullRequests);
    }
  }
  log(
    `stack map ${Object.entries(comments)
      .filter(([, list]) => list.length > 0)
      .map(([action, list]) => `${action} on ${list.join(' ')}`)
      .join('; ')}`,
  );
  log(`${plural(numbers.length, 'stacked PR')} into ${base}; review and merge them bottom-up: ${numbers.map(ref).join(', ')}`);
  return { pullRequests, nativeStack };
}
