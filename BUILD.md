# pr-split — build notes

## Plan

M3 of ROADMAP.md: *PR Opener & Stack Manager*, the last MVP milestone. M1 (analyzer and
dry-run script) and M2 (executor and validator) were built earlier in this session. I planned it
with three gstack plan-eng-review steps: Step 0 Scope Challenge, 1. Architecture review and
3. Test review. Nobody was available to ask, so I answered each question myself and recorded the
answer here.

### Step 0: Scope challenge

1. **What already solves parts of this?**
   - **M2 already builds, validates and pushes the stack.** `--execute --push` leaves N
     branches on the remote, each exactly one commit on the one before. Every commit already
     carries what a PR needs:
     - a conventional subject, which becomes the PR title;
     - `Part i/n of <feature>, split by pr-split.`, which identifies the layer;
     - `Refs: <issue>` when there is one.
     M3 reads the PRs' content from those branches instead of carrying the plan around, so
     `--execute --pr` and `--pr-only` produce the same bodies. **[Layer 1]**
   - **`gh`** creates and edits the PRs (`gh pr create/edit --body-file -`) and looks them up
     (`gh pr list --head … --json …`). It also covers comments (`gh api …/issues/N/comments`) and
     auth (`gh auth status`). **[Layer 1]**
   - **GitHub has native stacked PRs** (public preview since 2026-07-30). A REST endpoint,
     `POST /repos/{owner}/{repo}/stacks` with `{"pull_requests":[…]}`, links the PRs bottom-up.
     **[Layer 1]** **[EUREKA]**
     - This is what makes "each PR passes CI checks" true on GitHub. In a native stack,
       GitHub runs workflows and required checks as if every PR targeted the stack's base
       (`main`).
     - Without the link, PR #2 targets `pr-split/01-…`. A workflow with
       `pull_request: branches: [main]` (GitHub's starter-workflow default) then never runs on
       it, and required checks don't apply, so it looks green with nothing gating it.
     - So M3 links the stack natively instead of trying to analyze workflow files.
   - **GitHub already retargets the next PR** to `main` when the PR below merges, both in native
     stacks and when the merged branch is deleted. Basing each PR on the previous layer's branch
     is all it takes. **[Layer 1]**
   - **git's `--force-if-includes`** (git 2.30) refuses a forced push that would drop a commit
     you fetched but never integrated. `--pr-only` uses it; the review below explains why.
     **[Layer 1]**
2. **Minimum change set for the exit criteria and deliverables.**
   - `--pr`: after `--execute` succeeds, open one PR per layer, bottom-up. PR 1 targets the base;
     PR k targets layer k-1's branch. `--pr` implies `--push`, because a PR needs its branch on
     GitHub.
   - Each PR body has three sections:
     - **Summary**: the layer's name, a description and a file table with +/- counts.
     - **Dependencies**: `Depends on #<previous PR>`, plus every PR to merge first.
     - **Validation**: which checks this exact commit passed.
   - A stack-map comment on every PR, written after all of them exist so it can list every
     number. The native stack link is best-effort: a failure is a warning that comes with a
     `gh stack link …` hint.
   - Re-runs are idempotent:
     - Each branch's open PR is found again, and only what changed gets edited.
     - Only the text between pr-split's markers is replaced. Anything the user wrote stays.
     - The stack-map comment is edited in place, never duplicated.
   - `--pr-only`: skip the build. Find the stack pr-split built for this feature from the branches,
     push it, then open or update the PRs.
   - **Added because opening PRs makes them necessary:**
     - Check that `gh` is installed and logged in, and that `--base` names a branch, before
       anything is built.
     - Ignore fork PRs that happen to use the same head branch name (`isCrossRepository`).
     - Treat model and file-name text as plain text in the bodies. A description like "fixes #12"
       or "@someone" must not close an issue or ping a person.
     - If the PR step fails halfway, say which PRs exist and that `--pr-only` finishes the job.
   - **Deliberately not in M3:**
     - Waiting for CI results (`gh pr checks --watch`).
     - Draft PRs, reviewers and labels.
     - Closing stale PRs from an earlier, larger split.
     - Namespacing branch names per feature (it would change M1's tested names).
     - Fork-based stacks: GitHub doesn't support cross-fork stacks.
     - Payments: there's no REVENUE.md, and REVIEW.md finds no paid path, so no checkout or legal
       pages.
     - npm publish (no npm token here).
3. **Complexity check.**
   - New modules: `src/github.js` (the only code that runs `gh`) and `src/pr.js` (pure rendering
     plus the open/update loop). Zero classes.
   - `git.js` gets the stack reader. `cli.js` and `plan.js` get flags and a summary line.
   - Tests: a fake `gh` (`test/fake-gh.mjs`), the exit-criteria suite and a deliverables suite.
   - Plus the screenshots script, the package files, README and this file.
   - That's over the 8-file threshold, as in M2. Fewer files would mean mixing process spawning
     into `cli.js`, or putting JSON handling into the bash script. The scope stands.
   - The PR step lives in Node, not in the generated script. Each body needs the numbers gh
     returns for the PRs below it, and bash would have to parse JSON to get them.
4. **Search check.** WebSearch, from the gstack search check:
   - GitHub's stacked-PR docs and changelog: the native stacks, `gh stack link`, the Stacks REST
     API, CI behaviour in stacks, and that cross-fork stacks aren't supported.
   - `gh pr create/edit/list` flags: `--body-file -` reads stdin.
   - `gh pr list --head` also matches fork PRs. The known fix is to filter on `isCrossRepository`.
   - WebFetch was denied, so I couldn't read the Stacks API's response shape. pr-split only reads
     `number` from it and `stack` from a PR, and treats any failure as "not linked" plus a
     warning.
5. **TODOS.** There's no TODOS.md. M2 deferred "namespace branch names per feature" to M3, and it
   stays deferred (see above). New deferred work goes under "What's left".
6. **Completeness.** These cheap edge cases are in scope and tested:
   - PR step failures: a failure halfway (create or edit), gh missing, logged out or hanging, a
     base that isn't a branch.
   - Existing PRs: a hand-opened PR, a fork PR with the same head name, a user-edited body, a
     retargeted base.
   - The native stack: link failure, already linked.
   - Hostile text: file names with `|`, backticks or pr-split's own markers; LLM descriptions
     with mentions or closing keywords; odd branch names; more than 100 files or very long paths.
   - `--pr-only` cases: an unpushed stack, a reviewer's commit on the remote, several or broken
     stacks, flag conflicts.
7. **Distribution.** Unchanged: the npm CLI, Node ≥20.10, git and bash. `gh` is needed only for
   `--pr`/`--pr-only`, and `gh` handles the GitHub login, so pr-split never touches a token.
   Version 0.3.0. Publishing to npm stays deferred.

### 1. Architecture

```
argv ─► cli.main ─► flags: --pr (implies --push) / --pr-only, plus M1/M2 flags
          │
          ├─ --pr-only ─► git.findStack(feature)          the one complete chain of pr-split/* branches
          │               github.assertGh, git.branchName(base)
          │               git.pushBranches (--atomic --force-with-lease --force-if-includes -u)
          │
          └─ plan + script (M1/M2) ─► preflight with --pr: git.branchName(base), github.assertGh
                                      bash pr-split.sh: build, validate, push (unchanged)
                                      exit 0 ─► the plan's branches
                         ▼
   git.readStack(branches)   each branch: one pr-split commit for this feature on the one before;
                             title, name, summary, Refs from the commit; files from the diff
                         ▼
   pr.syncPullRequests(layers, github client)
     per layer, bottom-up:  gh pr list --head <branch>  (same-repo, open)
                            none   → gh pr create --base <parent> --title <subject> --body-file -
                            exists → gh pr edit <n> [--base] [--body-file -]   (only what changed;
                                     only the text between the pr-split markers is replaced)
     then:  link the native stack (GET pulls/N: .stack; POST stacks [n1..nN]), warn on failure
            stack-map comment on each PR: GET comments → PATCH ours or POST a new one
                         ▼
   stderr: "pr-split: opened #12 pr-split/02-api → pr-split/01-database: <url>", …
   --json: plan + execution + pullRequests + nativeStack on stdout
```

- **Boundaries.**
  - Processes: `git.js` runs git, `execute.js` runs bash, and the new `github.js` runs `gh`,
    always with argv arrays. Bodies go over stdin, so they never show up in the process list.
  - Rendering: `pr.js` is pure apart from `syncPullRequests`, which only talks to GitHub through
    the client it is given.
  - Injection: `cli.js` still injects every I/O edge. `env` reaches `gh`, so tests put a fake
    `gh` first on PATH.
- **One source of truth.** Branches → stack → bodies. `--pr-only` re-reads the same branches, so it
  writes the same bodies as `--execute --pr`.
  - The validation result is stored as a hidden marker in the body, tied to the commit SHA.
  - So a `--pr-only` re-run keeps "✅ passed build, test" for unchanged commits, and drops it for
    commits it didn't validate.
- **Security.**
  - pr-split never sees a GitHub token: `gh` holds the login.
  - Paths become code spans, with backtick fences sized to the path and `|` escaped in tables.
  - Model descriptions and layer names are escaped Markdown, with a zero-width space after `@` and
    `#`, so they can't mention people, reference or close issues, or inject links and HTML.
  - Validation commands are not posted, only their names: a local `--config` could hold
    anything.
  - The stack-map comment is found by a marker at the start of the comment body, so a quote of it
    elsewhere isn't edited.
  - Fork PRs are never adopted.
- **Failure scenarios** (each tested unless noted):
  - **A layer fails validation.** The script stops before pushing, so no PR is opened.
  - **gh is missing, logged out, or `--base` is a tag or SHA.** Exit 2 before any branch is created.
  - **`gh pr create` or `gh pr edit` fails partway** (network, permissions). Exit 1. The message
    names the step and the PRs that already exist, and says to run `--pr-only`, which reuses them.
  - **A `gh` call hangs.** It is stopped after 2 minutes, with "no answer within 120s".
  - **Stacks API errors** (unavailable on GitHub Enterprise Server, or a 422). Only a warning; the
    comment says the PRs aren't linked and how to link them.
  - **Someone edited the PR body.** Their text stays; only pr-split's section is replaced.
  - **Someone retargeted a PR.** A re-run sets the base back.
  - **A fork has a PR from a branch with the same name.** Ignored; pr-split opens its own.
  - **A reviewer pushed a fix to a layer branch, and you fetched it.** `--pr-only` refuses to
    push over it (`--force-if-includes`, atomic) and reports git's `[rejected]` line.
  - **Several stacks for the feature exist** (leftovers from an earlier split). `--pr-only` refuses
    to guess and lists them.
  - **The base of a PR in a native stack can't change** (GitHub refuses). gh's error is reported.
    Not tested against real GitHub.
- **Scaling.** About 5 gh calls per layer plus 1 for the link, sequential (N is small).
  - Each call has a 2-minute timeout.
  - The file table stops at 100 rows or 40,000 characters, then says "…and N more files", to
    stay under GitHub's 65,536-character body limit.
  - The comment lookup reads the first 100 comments. pr-split posts its comment right after
    opening the PR, so it's on that page.

### 3. Test plan

Runner: vitest. "GitHub" is `test/fake-gh.mjs`, a stand-in `gh` that keeps PRs, comments and
stacks in a JSON file and records every call:
- It only accepts a PR whose head and base branches exist on the test's bare remote, so
  "`--pr` pushes first" is checked for real.
- PR numbers start at 11, so an index can't pass for a number.
- No network, token or real gh is used.

| M3 exit criterion | Tests (`test/m3-exit-criteria.test.js`) |
|---|---|
| EC1 After `--execute --pr`, exactly N PRs are opened on GitHub | The real bin with `CI=true`: 3 open PRs, one per layer branch, heads pushed at the local SHAs; JSON lists them. A re-run after a new feature commit still has exactly 3 (updated, not duplicated) |
| EC2 PRs are stacked: PR #2 lists a dependency on PR #1, PR #3 on PR #2 | Bases: main ← 01 ← 02. Body k has `## Dependencies` with `Depends on #<PR k-1>`. Opened bottom-up. A native stack [11, 12, 13]. Each PR has one stack-map comment listing all three, with "this PR" marked |
| EC3 Each PR passes CI checks (as validated in M2) | Every layer passed validation before the first PR was opened. Each body names the passed checks and the validated SHA, and that SHA is the PR head on the remote. The native stack makes GitHub run `main`'s checks on every PR. A failing layer means no PR and no push |
| EC4 The PR body contains a generated summary of changes per group | Each body's `## Summary` has the group's name and description and exactly that group's files with the +/- counts from `git diff --numstat`. Earlier groups are summarized under Dependencies |

Deliverables beyond the ECs, in `test/pr.test.js`:
- `--pr-only`:
  - an unpushed stack gets pushed, then PRs are opened, marked as not validated;
  - after `--execute --pr` it's a no-op (no create, edit or PATCH) and keeps "validated";
  - a reviewer's fetched commit on the remote is never pushed over;
  - no stack, several stacks, a broken chain;
  - `--execute`/`--dry-run` conflicts.
- Re-runs:
  - user text outside the markers is kept;
  - a retargeted base is fixed;
  - comments are edited, not duplicated;
  - the native stack is not re-created.
- Existing PRs: a hand-opened PR is adopted with its text kept; a fork PR with the same head is
  ignored.
- Failures:
  - `gh pr create` fails on layer 2 → exit 1, then `--pr-only` finishes with exactly 3 PRs;
  - `gh pr edit` fails on a re-run → the PR is named;
  - a hanging gh → stopped, with a clear reason;
  - logged out → exit 2 with nothing built;
  - gh not on PATH → exit 2;
  - a base that isn't a branch → exit 2;
  - Stacks API 404 → warning and a "not linked" comment.
- Flags and output:
  - `--pr` dry run: the summary line, no gh calls, and the script still pushes;
  - `--base origin/main` → PRs target `main`;
  - `--remote` with `--pr`;
  - `--issue` → `Refs:` in the body;
  - `--help`;
  - the human-readable report in order.
- Rendering (pure):
  - mentions, references and links are neutralized, in descriptions and layer names;
  - code spans with backticks and pipes;
  - the 100-file and length caps, renames, binary files;
  - `mergeBody` cases, the validation marker round trip (including a stale copy), stack-map
    ordering;
  - native-link decisions (create, already linked, mixed, error, single PR) against an in-memory
    client.

## What the product does now

`pr-split` is a local CLI. Run it inside a git repository on a big feature branch and it:

1. Diffs the feature branch against the point where it left the base branch.
2. Groups the changed files into layers (database, api, ui, …) in dependency order. It uses a
   local Ollama model and falls back to path rules when Ollama isn't running.
3. Prints the plan: each layer's branch, its files, the validation commands, and how much smaller
   the biggest PR is.
4. Writes `pr-split.sh`, the bash script that builds the stack. By default that's all it does:
   a dry run.
5. With `--execute` it runs that script. Each layer becomes a branch, one commit on top of the
   layer below, and your build/test/lint commands run on each. It stops at the first failure.
6. **New in M3: with `--pr` it opens the stack on GitHub as pull requests**, using `gh`:
   - It pushes the branches, then opens one PR per layer, bottom-up. PR 1 targets `main`, and
     each later PR targets the branch of the PR below it, so every diff shows only its own layer.
   - Each PR body has a **Summary** of that group's files with line counts, **Dependencies**
     ("Depends on #128", plus everything to merge first), and **Validation** (which checks this
     exact commit passed).
   - It links the PRs as a **native GitHub stack**. GitHub then shows the stack, runs `main`'s
     checks on every PR, and retargets PRs as the ones below merge.
   - It posts a **stack-map comment** on each PR, with "this PR" marked.
   - **Re-running updates the same PRs**: bodies are refreshed, comments are edited, and nothing
     is duplicated. Text you add to a description outside pr-split's section is kept.
   - **`--pr-only`** does the PR part for a stack that is already built: it pushes, then opens or
     updates the PRs. Use it to finish an interrupted run, or after `--execute` without `--pr`.

The run's tail end (from the screenshots, sample repo):

```
pr-split: pr-split/04-docs passed validation (build, lint)
pr-split: pushed 4 branches to origin
pr-split: created 4 branches (each passed: build, lint): pr-split/01-database pr-split/02-api pr-split/03-ui pr-split/04-docs
pr-split: opened #128 pr-split/01-database → main: https://github.com/acme/shop/pull/128
pr-split: opened #129 pr-split/02-api → pr-split/01-database: https://github.com/acme/shop/pull/129
pr-split: opened #130 pr-split/03-ui → pr-split/02-api: https://github.com/acme/shop/pull/130
pr-split: opened #131 pr-split/04-docs → pr-split/03-ui: https://github.com/acme/shop/pull/131
pr-split: linked #128 #129 #130 #131 as GitHub stack 7
pr-split: stack map posted on #128 #129 #130 #131
pr-split: 4 stacked PRs into main; review and merge them bottom-up: #128, #129, #130, #131
```

## Run it locally

Requirements:
- Node ≥20.10 for the CLI (the test runner needs Node ≥22.12).
- git ≥2.22 (2.30 for `--pr-only`), and bash.
- For `--pr`/`--pr-only`: the GitHub CLI (`gh`), logged in with `gh auth login`.
- Ollama is optional.

```bash
npm install            # one runtime dependency: yaml
npm test               # vitest: 307 tests, 1 opt-in live Ollama test skipped
npm run build          # the website (site/) into dist/; see LAUNCH-READY.md
npm run screenshots    # regenerates docs/screenshots (needs CHROMIUM_PATH; not part of npm test)

# inside any git repo, on the branch you want to split:
node /path/to/pr-split/bin/pr-split.js --base main                  # plan + dry-run pr-split.sh
node /path/to/pr-split/bin/pr-split.js --base main --pr             # …also previews the push and PR step
node /path/to/pr-split/bin/pr-split.js --base main --execute --pr --issue 123   # build, validate, push, open PRs
node /path/to/pr-split/bin/pr-split.js --base main --pr-only        # open/update PRs for a stack built earlier
```

Flags:
- From M1: `--base`, `--feature` (default: the current branch), `--config`, `--script`,
  `--model`, `--no-llm`, `--json`, `--dry-run` (the default).
- From M2: `--execute`, `--retries <n>`, `--issue <ref>`, `--push`, `--remote <name>`, `--force`.
- New in M3:
  - `--pr`: after `--execute`, push and open or update one PR per layer. It implies `--push`;
    `--remote` picks the remote.
  - `--pr-only`: skip the build; push the stack pr-split already built for this feature, then
    open or update its PRs. It can't be combined with `--execute` or `--dry-run`.

Exit codes:
- 0 ok.
- 1 failure, including a layer that failed validation or a PR step that stopped partway.
- 2 bad usage, including gh missing or logged out, or a `--base` that isn't a branch, with `--pr`.

`.pr-split.yml` is unchanged from M2: `base`, `model`, `retries`, `validate`.

In CI (e.g. GitHub Actions):
- Check out with `fetch-depth: 0`.
- Set a git identity.
- For `--pr`, give `gh` a token through the job's `GH_TOKEN` secret. The token needs
  `contents: write` and `pull-requests: write`.

## Deploy (free tier)

There is nothing to host. pr-split is a CLI that runs on the developer's machine (or in their CI)
against a local Ollama, which is the only $0 LLM path (REVIEW.md: a hosted LLM service isn't free).
GitHub is reached through the user's own `gh` login; opening PRs is free on every GitHub plan.

- **CI**: `.github/workflows/ci.yml` runs the suite on GitHub Actions (free for public repos,
  and inside the free minutes for private ones) once the caller pushes the repo. The PR tests use
  the stand-in `gh`, so CI needs no secret.
- **Install from git**: `npm i -g github:<owner>/pr-split`, then run `pr-split --base main --execute --pr`.
- **npm** (public packages are free): `npm publish` from a maintainer account. No publish
  workflow yet (no npm token here).
- **Local checkout**: `npm link`.

`bin/pr-split.js` should be executable in git (`chmod +x bin/pr-split.js`). The sandbox blocks
`chmod`, so the caller should set it before committing. npm sets the mode on install, and
`node bin/pr-split.js` always works.

## Exit criteria

M3 (this milestone). Every check runs against the stand-in `gh`. **No real GitHub run was done
from the sandbox**: there is no network or GitHub login here.

| Criterion | Status |
|---|---|
| EC1 After `--execute --pr`, exactly N PRs are opened on GitHub | ✅ Spawned the bin with `CI=true`: exactly 3 open PRs, one per layer, heads pushed at the local SHAs. A re-run updates the same 3 |
| EC2 PRs are stacked: PR #2 lists a dependency on PR #1, PR #3 on PR #2, etc. | ✅ Each base is the branch below. Body k says `Depends on #<PR k-1>` and lists everything below. Each PR has a stack-map comment, and the PRs are linked as a native stack |
| EC3 Each PR passes CI checks (as validated in M2) | ✅ (locally) No PR is opened unless every layer passed validation. Each body records the passed checks and the validated SHA, which is the PR's head. The native stack link makes GitHub run `main`'s checks on every PR. That last part is from GitHub's docs and wasn't observed on real GitHub |
| EC4 The PR body contains a generated summary of changes per group | ✅ Each body's Summary has the group's name, description and its files with exact line counts, and nothing from other groups |

M1 and M2 still pass, unchanged:
- M1: the core analyzer suites; exactly "database" + "api" groups; correct
  `checkout`/`cherry-pick` lines; validation commands in the script.
- M2: N branches in CI; each passes validation; each is based on the previous layer; no extra
  files.

`npm test`: **271 passed, 1 skipped** at M3 (the opt-in live Ollama test, `PR_SPLIT_LIVE_OLLAMA=1`);
307 passed after go-live added the website tests (`test/site.test.js`).

## Infrastructure

The CLI needs no database, API key or hosted service:
- PRs are opened by the user's own `gh` login, which pr-split never reads.
- Tests use the stand-in `gh`.

Go-live added a static website (`site/`, deployed to Vercel) and a `.provision` file asking for the
Vercel project and a Stripe payment link. See LAUNCH-READY.md.

## Decisions (made without a human; recorded here)

- **`--pr` implies `--push`**, because a PR needs its branch on GitHub.
- **PR step order**: open/update all PRs bottom-up, then link the native stack, then write the
  comments, so the stack map can list every number and say whether the link worked.
- **PR content comes from the branches**, not the plan:
  - title = the commit subject;
  - description = the subject without its `type(scope):`;
  - files = `git diff` of the layer commit.
  So `--pr-only` writes the same bodies as `--execute --pr`.
- **Titles belong to the author once a PR exists.** Re-runs update only the base and pr-split's
  section of the body.
- **A PR opened by hand for a layer branch is adopted.** Its description stays, with pr-split's
  section added below it.
- **The validation record is tied to a commit SHA.** `--pr-only` keeps "✅ passed" only for a
  commit an earlier run validated; otherwise it says "⚠️ Not validated by this pr-split run".
- **Only validation command names are posted**, never the commands themselves.
- **Native stack linking is best-effort.** If the PRs are already one stack, it's left alone.
  If only some are in a stack, or the API fails, pr-split warns with a `gh stack link …` hint.
  It never fails the run, so GitHub Enterprise Server (no stacks yet) still works.
- **The stack-map comment is found by its leading marker.** Only the first 100 comments are read,
  because pr-split posts it right after opening the PR.
- **`--pr-only` push**: `--atomic --force-with-lease --force-if-includes`. The `--execute` script
  keeps M2's push, because `--force-if-includes` would reject every re-run from a fresh CI clone
  (no reflog there).
- **`--pr-only` won't guess.** If more than one complete stack exists for the feature, it lists
  them and stops.
- **gh failures before building are exit 2** (like M2's missing remote); a PR step failing after
  the branches exist is exit 1.
- **Screenshots render the PR from the stand-in's stored state, with `marked`**, and say so on
  the page. `marked` and `playwright-core` are dev dependencies only, and no browser is
  downloaded.
- **Version 0.3.0** for M3. Test timeout raised to 60s for slower CI runners; no test was loosened.
- Earlier decisions still hold:
  - JavaScript (ESM + JSDoc) and vitest.
  - The Ollama fallback.
  - The two-step script.
  - `pr-split/NN-<group>` branch names.
  - Unknown config keys are errors.
  - Stop at the first failing layer.
  - Stash leftovers, never `reset --hard`.
  - Conventional commits with a `Refs:` trailer.
  - The script excluded via `.git/info/exclude`.

## What's left

- **A run against real GitHub.** Everything was tested against the stand-in `gh`. The first real
  run should check:
  - `gh pr create/edit/list` as used here;
  - the Stacks API call and the `stack` field;
  - that GitHub runs `main`'s workflows on every PR of a linked stack.
- **REVIEW.md's key test is still open.** Do the layers of three real 20+ file branches each
  build green? File-level splits still can't fix a file that mixes concerns.
- **Waiting for CI** (`gh pr checks --watch`) after opening the PRs isn't built.
- **Stale PRs aren't handled.**
  - A re-run with fewer layers leaves the old top PRs open.
  - Re-running after the bottom PR merged opens new PRs, because branch names carry the layer
    number.
  - Namespacing branch names per feature would fix both, but changes M1's names.
- **Growing a native stack.** When a re-run adds a layer, pr-split warns and suggests
  `gh stack link`; it doesn't call the "add pull requests to a stack" endpoint (its path wasn't
  verifiable here).
- **Fork workflows** (a stack pushed to a fork) aren't supported. GitHub doesn't support
  cross-fork stacks either.
- **Taking money.** REVENUE.md now sets $9 once. The website's Buy button links to a Stripe payment
  link (LAUNCH-READY.md). The CLI doesn't gate any feature behind it.
- No timeout for validation commands. No baseline validation of the base branch.
- The M2 script's push still uses `--force-with-lease` without `--force-if-includes` (see Review).
- CI covers Linux only. No npm publish workflow. No OpenAI/Anthropic fallback.
- `test/zz-demo.test.js` would read better as `test/report.test.js`; the sandbox blocked
  renaming it.

## Review

Self-review of the M3 changes against gstack's pre-landing checklist ("Review Categories" and the
"Fix-First Heuristic"). Nothing is committed yet, so `git diff` can't separate M3 from M1 and M2.
I reviewed the M3 files directly:
- `src/{github,pr}.js`, and the M3 parts of `src/{cli,git,plan}.js`;
- `test/{fake-gh.mjs,m3-exit-criteria.test.js,pr.test.js}` and `test/helpers.js`;
- `scripts/screenshots.mjs`, the CI workflow, and the package files.

**Fixed during review** (each with a test):
- `[P1] (confidence: 8/10) src/git.js pushBranches`, data safety:
  - Problem: `--pr-only` pushed with plain `--force-with-lease`. If a reviewer pushed a fix to
    `pr-split/02-api` and you had fetched it, the lease passed and the fix was overwritten on
    GitHub.
  - Fix: the push is now `--atomic --force-with-lease --force-if-includes`. It is rejected, all or
    nothing, and the message shows git's `[rejected]` line.
- `[P2] (confidence: 8/10) src/git.js git()`:
  - Problem: a failed push reported `To <url>`, git's first stderr line, instead of the reason.
  - Fix: the message prefers a `[rejected]` line, then the first `error:` or `fatal:` line.
- `[P2] (confidence: 7/10) src/pr.js`, LLM/branch trust boundary:
  - Problem: layer names went into bodies and the stack-map table unescaped. Under `--pr-only`
    they come from branch names, which may contain `|`, `@` or `#`.
  - Fix: names now go through `mdText` like descriptions.
- `[P2] (confidence: 7/10) src/pr.js prSection`:
  - Problem: 100 rows of very long paths could exceed GitHub's 65,536-character body limit, and
    `gh` would fail.
  - Fix: the file table also stops at 40,000 characters.
- `[P3] (confidence: 6/10) src/pr.js validatedChecks`:
  - Problem: only the first validation marker was read, so a stale copy in the author's text
    could hide the real one.
  - Fix: every marker is checked for the matching SHA.
- `[P3] (confidence: 6/10) src/github.js`:
  - Problem: a timed-out `gh` call said "stopped by SIGTERM".
  - Fix: it now says "no answer within 120s".
- `[P3] (confidence: 6/10) src/pr.js`:
  - Problem: a failed `gh pr edit` was reported as "couldn't open the PR".
  - Fix: messages now name the step (look up, open, or update #N).
- Tests: three EC tests passed vacuously against an empty PR list before the feature existed.
  Each now asserts there are 3 PRs first.

**Pass 1 (CRITICAL), checked:**
- SQL & data safety: no database.
  - The remote-overwrite case is fixed above.
  - Bodies only replace pr-split's own section.
  - Fork PRs are never edited.
- Races: one process, sequential gh calls. Two pr-split runs on the same PR at once could both
  post a stack-map comment (check-then-create). Informational.
- LLM output trust boundary:
  - Model descriptions and layer names are escaped, with `@` and `#` neutralized, before they
    reach GitHub.
  - Paths are code spans.
  - No LLM output is fetched, stored or run.
- Shell injection: `gh` and `git` always run with argv arrays, and bodies go through stdin. The
  new code adds nothing to the bash script.
- Enum & value completeness:
  - `pr` was added to the plan and is read by `formatSummary`; `renderScript` doesn't need it.
  - PR actions (`opened`, `updated`, `unchanged`) and comment actions (`posted`, `updated`,
    `unchanged`) are each handled in the report.
  - An unexpected comment action fails loudly inside the PR step.

**Left open (informational, no CRITICAL remaining):**
- `[P2] (confidence: 6/10)` Medium confidence, verify against real GitHub. The Stacks API
  response shape and the PR `stack` field are taken from GitHub's docs (via search), not
  observed.
- `[P2] (confidence: 6/10)` The `--execute` script's push still lacks `--force-if-includes`.
  - `--execute` rebuilds every layer from the feature branch by design, so a reviewer's commit
    pushed only to a layer branch is replaced.
  - Adding the flag would break re-runs from fresh CI clones.
  - The fix is to fold review fixes into the feature branch. That should be documented for users.
- `[P3] (confidence: 5/10)` A re-run that adds a layer to an existing native stack only warns; it
  doesn't extend the stack.
- `[P3] (confidence: 5/10)` The first 100 comments are scanned for the stack map. If someone
  re-posts a 101st copy by hand, it's ignored.
- Distribution: CI runs on Linux only. There's still no publish workflow.
