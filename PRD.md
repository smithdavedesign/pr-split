# PR Splitter AI - PRD

## Problem
Developers and AI coding assistants generate large pull requests that overwhelm human reviewers, leading to delayed feedback, shallow reviews, and increased merge conflicts. Reviewers cannot hold dozens of files in working memory, causing cognitive overload and rubber-stamping. This bottleneck slows development velocity and reduces code quality, especially as AI-generated code increases PR size without increasing reviewer capacity.

## Target user
- Individual developers (freelancers, open-source contributors) who use AI coding assistants and struggle to get timely feedback on large PRs.
- Engineering teams seeking to improve review efficiency and maintain high code review standards in the face of AI-driven productivity gains.
- Repository maintainers who want to enforce PR hygiene without imposing manual overhead on contributors.

## Competitors & gap
| Competitor | What they do | Gap |
|------------|--------------|-----|
| Kit AI Code Reviewer | Reviews code, summarizes PRs | Does not help split PRs; user must manually act on review feedback to reduce size. |
| DiffEnder/pr-splitter CLI | Automatically breaks large PRs | Uses heuristics, not AI-driven logical grouping; may split arbitrarily, breaking logical cohesion. |
| Tessl split-pr skill | Suggests how to split changes | Manual invocation; does not create branches or PRs automatically. |
| danielsinai/pr-splitter | Shell-based splitter | No AI analysis; relies on user-defined rules. |
| GitHub Stacked PRs (native) | Manages stacked PRs | Requires user to manually define layers; does not automate decomposition. |
| AI PR summarizers | Summarizes PR content | Does not reduce PR size; only provides a summary. |

**Our gap**: An AI-powered assistant that analyzes a feature branch, suggests logical PR splits based on dependencies and file categorization, creates the corresponding branches, validates each split, and opens stacked PRs with proper dependency chains—turning a large PR into a reviewable stack with minimal manual effort.

## MVP scope
- Analyze changed files in a feature branch vs. base branch using `git diff`.
- Invoke an LLM (via Ollama API or compatible) to categorize files into logical groups (e.g., data, API, UI, tests) and determine dependency order.
- Generate a validation-ready branch creation script (or execute directly) that:
  - Creates branches from appropriate base (each layer builds on previous).
  - Cherry-picks files for each branch.
  - Runs configurable validation commands (build, test, lint).
  - Commits with standard messages referencing an issue/ticket.
- Use GitHub CLI (`gh`) to open pull requests in dependency order (stacked PRs), with PR bodies noting dependencies.
- Provide a `--dry-run` mode to preview proposed splits and script without mutating the repo.
- Support configuration via a simple YAML file (project validation commands, base branch, etc.).
- Output a human-readable summary of the split plan (files per PR, estimated review effort reduction).

## Non-goals
- Writing code or fixing bugs; the tool only organizes existing changes.
- Enforcing semantic commit splits within a file (patch-level splitting) — focus is on file-level grouping.
- Replacing code review; the tool aims to make review more effective, not eliminate it.
- Supporting non-Git platforms (GitLab, Bitbucket) in MVP; focus on GitHub via `gh`.
- Real-time PR monitoring or automatic suggestions on opened PRs (could be future extension).

## Success metrics
- Median time from PR creation to first review feedback reduced by 30% (based on team baseline).
- Average PR file count in merged PRs reduced from >30 to <15.
- User satisfaction: ≥80% of surveyed developers report the tool made review easier and feedback more useful.
- Zero regressions: validation step ensures each split PR passes build/tests/lint before proceeding.

## Open questions
- How to best detect cross-file dependencies beyond simple categorization (e.g., when a UI component uses a utility function)? Could augment AI with static analysis for supported languages.
- What is the optimal balance between AI prompting speed and cost? Should we default to local Ollama models?
- How to handle monorepos or projects with unconventional folder structures? May need configurable path mappings.
- Should the tool also suggest commit-level splitting (e.g., separating formatting from logic) within each PR?