# PR Splitter AI - Roadmap

## M1: Analyzer & Script Generator (Weekend-deliverable)
**Goal**: Analyze a feature branch, propose logical file groupings, and generate a dry-run script that shows the split plan without mutating the repo.

**Deliverables**:
- CLI tool that takes `--base <branch> --feature <branch>` and outputs a categorized file list.
- LLM integration (via Ollama API) to produce grouping and dependency order.
- Generated bash script (dry-run) that outlines branch creation, file cherry-picks, and validation steps (but does not execute git commands).
- Simple YAML config for validation commands and base branch.
- Unit tests for file parsing and LLM prompting.

**Exit criterion (testable checks)**:
- `npm test` passes for core analyzer module.
- Given a test repo with known file changes (e.g., 5 database files, 5 API files), the tool outputs exactly two groups: “database” and “api”.
- Dry-run script includes correct `git checkout` and `git cherry-pick` commands for each group.
- Validation step in script calls the configured build/test/lint commands.

## M2: Executor & Validator (Weekend-deliverable)
**Goal**: Execute the generated script to create branches, run validation, and ensure each split PR can be built and tested independently.

**Deliverables**:
- Flag `--execute` to run the generated git commands (branch creation, file checks, commits).
- Automatic validation after each branch is created (build, test, lint) with configurable retry.
- Error handling: if validation fails, stop and report which branch failed.
- Commit messages follow conventional format with issue reference.
- Push branches to remote (optional flag).

**Exit criterion (testable checks)**:
- In a CI environment, running the tool with `--execute` on a test feature branch creates N branches.
- Each branch passes the validation script (exit code 0).
- Branches are correctly based on previous layer (checked via `git merge-base`).
- No extraneous files outside the selected groups are present in each branch.

## M3: PR Opener & Stack Manager (Weekend-deliverable)
**Goal**: Open stacked pull requests with proper dependency chains and PR bodies that link to each other.

**Deliverables**:
- Use GitHub CLI (`gh`) to create PRs in dependency order.
- PR bodies include a “Dependencies” section noting which PRs must be merged first.
- Optional `--pr-only` mode to create PRs from existing branches (useful for debugging).
- Stack map comment in each PR (leveraging GitHub’s native stacked PRs UI).
- Ability to update PR bodies if re-run.

**Exit criterion (testable checks)**:
- After running tool with `--execute --pr`, exactly N PRs are opened on GitHub.
- PRs are stacked: PR #2 lists dependency on PR #1, PR #3 on PR #2, etc.
- Each PR passes CI checks (as validated in M2).
- The PR body contains a generated summary of changes per group.

## Suggested Stack
- **Language**: Node.js (TypeScript) for CLI and scripting.
- **LLM access**: Ollama API (default) for local, zero-cost models; fallback to OpenAI/Anthropic via env vars.
- **Git operations**: Simple wrapper around `git` and `gh` CLI (both assumed installed).
- **Config**: YAML file (`.pr-split.yml`) with validation commands, base branch, etc.
- **Testing**: Jest for unit tests, fixtures with sample repo structures.
- **Why**: TypeScript provides safety for CLI logic; Ollama enables local AI; `gh` is the standard for GitHub automation; YAML config is easy to override.