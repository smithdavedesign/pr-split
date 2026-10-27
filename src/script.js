// Renders the plan as a bash script. Pure string generation: every value is single-quoted.
//
// Step 1 builds one commit per group on the merge base, where `git checkout <feature> -- <files>`
// is exact. Step 2 stacks those commits on the base with `git cherry-pick`, a 3-way merge, so
// changes that landed on the base after branching are kept (or conflict loudly) instead of being
// overwritten by the feature's copy of the file.

export const FILES_PER_COMMAND = 25;

export function shellQuote(value) {
  const text = String(value);
  if (text.includes('\0')) throw new Error('cannot put a NUL byte in a shell argument');
  return `'${text.replaceAll("'", "'\\''")}'`;
}

const chunk = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

const quoteAll = (values) => values.map(shellQuote).join(' ');

/** Comments are the one place values aren't quoted, so a newline must never end one early. */
const comment = (text) => `# ${text.replace(/[\u0000-\u001f\u007f]/g, ' ')}`;

function groupCommit(plan, group) {
  const removed = [];
  const checkedOut = [];
  for (const file of group.files) {
    if (file.status === 'D') removed.push(file.path);
    else checkedOut.push(file.path);
    if (file.status === 'R') removed.push(file.oldPath);
  }
  const lines = [
    comment(`${group.index}/${plan.groups.length} ${group.name} (${group.files.length} file${group.files.length === 1 ? '' : 's'})`),
    `run git checkout -q -B ${shellQuote(group.tempBranch)} ${shellQuote(plan.mergeBase)}`,
  ];
  // Removals first, so a path can turn from a file into a directory (or back) within one group.
  for (const paths of chunk(removed, FILES_PER_COMMAND)) lines.push(`run git rm -q -- ${quoteAll(paths)}`);
  for (const paths of chunk(checkedOut, FILES_PER_COMMAND)) {
    lines.push(`run git checkout ${shellQuote(plan.featureSha)} -- ${quoteAll(paths)}`);
  }
  const { subject, body, trailers } = group.commit;
  const paragraphs = [subject, body, ...(trailers.length > 0 ? [trailers.join('\n')] : [])];
  lines.push(`run git commit -q ${paragraphs.map((p) => `-m ${shellQuote(p)}`).join(' ')}`);
  return lines;
}

function layer(plan, group) {
  const lines = [
    comment(`${group.index}/${plan.groups.length} ${group.name} on ${group.parent}`),
    `run git checkout -q -B ${shellQuote(group.branch)} ${shellQuote(group.parent)}`,
    `run git cherry-pick ${shellQuote(group.tempBranch)}`,
  ];
  if (plan.validate.length === 0) {
    lines.push('# No validation commands configured (add "validate:" to .pr-split.yml).');
  }
  for (const { name, command } of plan.validate) lines.push(`validate ${shellQuote(name)} ${shellQuote(command)}`);
  lines.push(`layer_done ${shellQuote(group.branch)} ${shellQuote(group.parent)}`);
  return lines;
}

// Helpers the script defines. `run` and `validate` print in a dry run and only act with
// PR_SPLIT_EXECUTE=1; the rest is only called when executing. Written as String.raw so bash's
// backslashes stay as they are; bash's "${" is escaped as "\${" here and unescaped below.
const FUNCTIONS = String.raw`run() {
  printf '+'; printf ' %q' "$@"; printf '\n'
  if [ "$EXECUTE" = 1 ]; then
    printf -v STEP ' %q' "$@"
    "$@"
  fi
}
# Runs a validation command on the current layer, retrying it up to $RETRIES more times.
validate() {
  printf '+ [validate:%s] %s\n' "$1" "$2"
  if [ "$EXECUTE" != 1 ]; then return 0; fi
  local attempt=1 code branch
  branch="$(git branch --show-current)"
  STEP=" [validate:$1] $2"
  # Validation commands see paths as patterns again, like in the user's own shell.
  until (unset GIT_LITERAL_PATHSPECS; bash -c "$2"); do
    code=$?
    if [ "$attempt" -gt "$RETRIES" ]; then
      FAILURE="validation \"$1\" failed on $branch (exit code $code, $attempt attempt$([ "$attempt" = 1 ] || echo s)). The branch keeps its commit, so you can inspect it: git checkout $branch"
      exit "$code"
    fi
    attempt=$((attempt + 1))
    echo "pr-split: validation \"$1\" failed on $branch; retrying (attempt $attempt of $((RETRIES + 1)))" >&2
  done
}
# A layer ($1, on top of $2) is done when its validation passed, left tracked files alone (or the
# next layer would start from those changes) and left the branch as exactly one commit on $2.
layer_done() {
  if [ "$EXECUTE" != 1 ]; then return 0; fi
  local changed
  changed="$(git status --porcelain --untracked-files=no)"
  if [ -n "$changed" ]; then
    FAILURE="the validation commands changed tracked files (they must leave them alone, e.g. npm ci instead of npm install):"$'\n'"$changed"
    exit 1
  fi
  if [ "$(git branch --show-current)" != "$1" ] || [ "$(git rev-list --count "$2..$1")" != 1 ]; then
    FAILURE="the validation commands switched branches or made commits; $1 must be exactly one commit on top of $2"
    exit 1
  fi
  DONE="$DONE $1"
  echo "pr-split: $1 $PASSED" >&2
}
# Refuses to overwrite a branch whose last commit isn't pr-split's own for this feature.
check_branch() {
  local message
  message="$(git log -1 --format=%B "refs/heads/$1" -- 2>/dev/null)" || return 0
  case "$message" in *"$MARKER"*) return 0 ;; esac
  echo "pr-split: $1 already exists and its last commit was not made by pr-split for $FEATURE." >&2
  echo "pr-split: delete it (git branch -D $1) or rerun with --force to overwrite it." >&2
  exit 1
}
# On any failure: say where it stopped, undo a half-done cherry-pick, keep leftover changes in a
# stash, and go back to the feature branch. Layers that passed stay as they are.
on_exit() {
  local code=$? branch
  trap - EXIT
  if [ "$code" = 0 ]; then return 0; fi
  set +e
  branch="$(git branch --show-current 2>/dev/null)"
  echo "pr-split: FAILED on \${branch:-a detached HEAD}: \${FAILURE:-command failed with exit code $code:$STEP}" >&2
  if git rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null 2>&1; then
    git cherry-pick --abort >/dev/null 2>&1
    echo "pr-split: aborted the cherry-pick: this layer conflicts with (or is already in) $BASE, which changed since $FEATURE branched off; rebase $FEATURE onto $BASE, then run pr-split again." >&2
  fi
  if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] &&
    git stash push -q -m "pr-split: changes left on $branch" >/dev/null 2>&1; then
    echo "pr-split: saved the changes left in tracked files with git stash (git stash show -p to see them)" >&2
  fi
  if git checkout -q "$FEATURE" >/dev/null 2>&1; then
    git branch -q -D "\${TEMP_BRANCHES[@]}" >/dev/null 2>&1
    echo "pr-split: back on $FEATURE" >&2
  else
    echo "pr-split: could not switch back to $FEATURE; still on \${branch:-a detached HEAD}" >&2
  fi
  echo "pr-split: passed validation before the failure:\${DONE:- none}" >&2
  exit "$code"
}`.replaceAll('\\${', '${');

/** @param {ReturnType<typeof import('./plan.js').buildPlan>} plan */
export function renderScript(plan) {
  const count = plan.groups.length;
  const branches = plan.groups.map((g) => g.branch);
  const checks = plan.validate.map((v) => v.name).join(', ');
  const branchWord = `branch${count === 1 ? '' : 'es'}`;
  const finished = `pr-split: created ${count} ${branchWord}${checks ? ` (each passed: ${checks})` : ''}: ${branches.join(' ')}`;
  const preflight = plan.force
    ? ['  # --force: existing pr-split branches are overwritten without checking']
    : branches.map((branch) => `  check_branch ${shellQuote(branch)}`);
  if (plan.push) preflight.push(`  git remote get-url ${shellQuote(plan.push)} >/dev/null`);
  const push = plan.push
    ? [
        '',
        '# Push the stack: only reached when every layer passed',
        `run git push --force-with-lease -u ${shellQuote(plan.push)} ${quoteAll(branches)}`,
        `if [ "$EXECUTE" = 1 ]; then echo ${shellQuote(`pr-split: pushed ${count} ${branchWord} to ${plan.push}`)} >&2; fi`,
      ]
    : [];
  return [
    '#!/usr/bin/env bash',
    comment(`Generated by pr-split: splits ${plan.feature} (${plan.featureSha})`),
    comment(`into ${count} stacked ${branchWord} on top of ${plan.base}.`),
    '#',
    '# Dry run by default: every command is printed and nothing is executed.',
    '# PR_SPLIT_EXECUTE=1 runs the commands for real (needs a clean working tree);',
    '# that is what pr-split --execute does. It stops at the first failure and says where.',
    'set -euo pipefail',
    '# File names are paths, not patterns: "app/[id]/page.tsx" must not also match "app/i/page.tsx".',
    'export GIT_LITERAL_PATHSPECS=1',
    '',
    'EXECUTE="${PR_SPLIT_EXECUTE:-0}"',
    `BASE=${shellQuote(plan.base)}`,
    `FEATURE=${shellQuote(plan.feature)}`,
    `TEMP_BRANCHES=(${quoteAll(plan.groups.map((g) => g.tempBranch))})`,
    `MARKER=${shellQuote(` of ${plan.feature}, split by pr-split.`)}`,
    comment(`Each failing validation command is retried up to ${plan.retries} more time(s).`),
    `RETRIES=${plan.retries}`,
    `PASSED=${shellQuote(checks ? `passed validation (${checks})` : 'created (no validation configured)')}`,
    'STEP=""',
    'FAILURE=""',
    'DONE=""',
    FUNCTIONS,
    '',
    'if [ "$EXECUTE" = 1 ]; then',
    '  cd "$(git rev-parse --show-toplevel)"',
    '  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then',
    '    echo "pr-split: commit or stash your changes first" >&2',
    '    exit 1',
    '  fi',
    ...preflight,
    '  trap on_exit EXIT',
    'fi',
    '',
    comment(`Step 1: one commit per group, built on the merge base ${plan.mergeBase}`),
    ...plan.groups.flatMap((group) => [...groupCommit(plan, group), '']),
    comment(`Step 2: stack the groups on ${plan.base} and validate each layer`),
    ...plan.groups.flatMap((group) => [...layer(plan, group), '']),
    '# Clean up: back to the feature branch, drop the temporary branches',
    `run git checkout -q ${shellQuote(plan.feature)}`,
    `run git branch -q -D ${quoteAll(plan.groups.map((g) => g.tempBranch))}`,
    ...push,
    `if [ "$EXECUTE" = 1 ]; then echo ${shellQuote(finished)} >&2; fi`,
    '',
  ].join('\n');
}
