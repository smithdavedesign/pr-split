// Turns ordered groups into a stack of branches, and renders the human-readable summary.

export const BRANCH_PREFIX = 'pr-split';
/** commitlint's default header-max-length. */
export const MAX_SUBJECT_LENGTH = 100;

const sumLines = (files) => files.reduce((sum, f) => sum + f.additions + f.deletions, 0);

/** Conventional commit type per group name; any other group is new code, so "feat". */
const COMMIT_TYPES = {
  docs: 'docs',
  doc: 'docs',
  documentation: 'docs',
  tests: 'test',
  test: 'test',
  config: 'chore',
  tooling: 'chore',
  build: 'build',
  ci: 'ci',
};

/** "Schema and models" → "schema and models", but "API routes" stays. */
const lowerFirst = (text) => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);

/**
 * The layer's commit as a conventional commit: `type(group): summary`, a body naming the feature
 * (pr-split recognizes its own branches by that line), and a `Refs:` trailer for the issue.
 */
export function commitMessage({ name, description, index, count, feature, issue }) {
  const prefix = `${COMMIT_TYPES[name] ?? 'feat'}(${name}): `;
  let summary = description ? lowerFirst(description) : `part ${index} of ${feature}`;
  const room = MAX_SUBJECT_LENGTH - prefix.length;
  if (summary.length > room) {
    const cut = summary.slice(0, room + 1);
    summary = (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut.slice(0, room)).trimEnd();
  }
  return {
    subject: `${prefix}${summary}`,
    body: `Part ${index}/${count} of ${feature}, split by pr-split.`,
    trailers: issue ? [`Refs: ${issue}`] : [],
  };
}

/**
 * @param {{ base: string, feature: string, mergeBase: string, featureSha: string,
 *   groups: { name: string, description: string, files: import('./git.js').ChangedFile[] }[],
 *   validate: import('./config.js').ValidationCommand[], source: 'ollama' | 'heuristic',
 *   model: string | null, warnings: string[],
 *   retries?: number, issue?: string | null, push?: string | null, force?: boolean, pr?: boolean }} input
 *   `push` is the remote to push to after every layer passed, or null. `pr`: open the stack as
 *   pull requests once it is pushed (--pr).
 */
export function buildPlan({
  base,
  feature,
  mergeBase,
  featureSha,
  groups,
  validate,
  source,
  model,
  warnings,
  retries = 0,
  issue = null,
  push = null,
  force = false,
  pr = false,
}) {
  let parent = base;
  const layers = groups.map((group, i) => {
    const slot = `${String(i + 1).padStart(2, '0')}-${group.name}`;
    const layer = {
      index: i + 1,
      name: group.name,
      description: group.description,
      branch: `${BRANCH_PREFIX}/${slot}`,
      tempBranch: `${BRANCH_PREFIX}/tmp/${slot}`,
      parent,
      commit: commitMessage({ ...group, index: i + 1, count: groups.length, feature, issue }),
      files: group.files,
      additions: group.files.reduce((sum, f) => sum + f.additions, 0),
      deletions: group.files.reduce((sum, f) => sum + f.deletions, 0),
    };
    parent = layer.branch;
    return layer;
  });
  const allFiles = layers.flatMap((layer) => layer.files);
  return {
    base,
    feature,
    mergeBase,
    featureSha,
    source,
    model,
    totalFiles: allFiles.length,
    totalLines: sumLines(allFiles),
    groups: layers,
    validate,
    retries,
    issue,
    push,
    force,
    pr,
    warnings,
  };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** Config text shown on the terminal: a newline or escape sequence must not rewrite the output. */
const printable = (text) => text.replace(/[\u0000-\u001f\u007f]/g, ' ');

/** How much smaller the biggest PR in the stack is than the original one. */
export function reviewReduction(plan) {
  const largest = plan.groups.reduce(
    (max, g) => {
      const lines = sumLines(g.files);
      return lines > max.lines || (lines === max.lines && g.files.length > max.files) ? { files: g.files.length, lines } : max;
    },
    { files: 0, lines: -1 },
  );
  const byLines = plan.totalLines > 0;
  const percent = Math.round(
    100 * (1 - (byLines ? largest.lines / plan.totalLines : largest.files / plan.totalFiles)),
  );
  return { largestFiles: largest.files, largestLines: largest.lines, percent };
}

export function formatSummary(plan, scriptPath, { execute = false } = {}) {
  const source = plan.source === 'ollama' ? `grouped by Ollama (${plan.model})` : 'grouped by file paths';
  const out = [
    `pr-split: ${plan.feature} → ${plan.base}`,
    `${plural(plan.totalFiles, 'file')}, ${plural(plan.totalLines, 'changed line')} → ${plural(plan.groups.length, 'stacked PR')} (${source})`,
    '',
  ];
  for (const g of plan.groups) {
    out.push(`${g.index}. ${g.name}${g.description ? `: ${g.description}` : ''}`);
    out.push(`   branch ${g.branch} (based on ${g.parent}) · ${plural(g.files.length, 'file')} · +${g.additions} -${g.deletions}`);
    for (const f of g.files) {
      out.push(`     ${f.status}  ${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}`);
    }
    out.push('');
  }
  const r = reviewReduction(plan);
  out.push(
    `Review effort: the largest PR has ${plural(r.largestFiles, 'file')} / ${plural(r.largestLines, 'line')} ` +
      `instead of ${plural(plan.totalFiles, 'file')} / ${plural(plan.totalLines, 'line')} (${r.percent}% smaller).`,
  );
  const retried = plan.retries > 0 ? ` (retried up to ${plural(plan.retries, 'time')})` : '';
  out.push(
    plan.validate.length > 0
      ? `Validation after each layer: ${plan.validate.map((v) => printable(v.name)).join(', ')}${retried}`
      : 'No validation commands configured (add "validate:" to .pr-split.yml).',
  );
  // The commands come from the checked-out .pr-split.yml: show them before anything runs them.
  for (const { name, command } of plan.validate) out.push(`  ${printable(name)}: ${printable(command)}`);
  if (plan.issue) out.push(`Commits reference: ${plan.issue}`);
  if (plan.push) out.push(`Push: to ${plan.push} once every layer has passed (git push --force-with-lease)`);
  if (plan.pr) {
    out.push(
      `Pull requests: then opens or updates ${plural(plan.groups.length, 'stacked PR')} on GitHub with gh, ` +
        'bottom-up, each based on the one below it; links them as a GitHub stack and posts a stack map on each',
    );
  }
  out.push(
    execute
      ? `Running ${scriptPath} now (--execute); it is the same script a dry run writes.`
      : `Dry-run script: ${scriptPath} (nothing was executed; \`bash ${scriptPath}\` prints the commands, --execute runs them)`,
  );
  return `${out.join('\n')}\n`;
}
