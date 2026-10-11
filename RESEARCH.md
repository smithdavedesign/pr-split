# PR Splitter AI - Research

## Summary
Large pull requests are a growing bottleneck in code review, exacerbated by AI-generated code. Reviewers face cognitive overload, leading to shallow feedback and delayed merges. The solution is to automatically split large feature branches into logical, stacked pull requests using AI dependency analysis, making each PR small enough for thorough review while preserving the overall feature intent.

## Evidence of the Problem
- Code review complaints grew from 3.8% in 2024 to 4.8% in 2026, with PR size being the most-voted sub-theme (0.99 votes per card)【https://dev.to/kelly_lewandowski_845215e/code-review-is-the-only-bottleneck-thats-growing-we-have-the-data-9e5】.
- AI coding assistants increase code volume without increasing human reviewer capacity, widening the review queue【same】.
- GitHub acknowledges the issue: “Instead of one huge, un-reviewable pull request, teach coding agents to decompose work into a clean, ordered stack”【https://github.blog/engineering/turn-one-giant-ai-generated-pull-request-to-a-reviewable-stack】.
- Manual splitting is time-consuming and error-prone, but AI can assist in analyzing changes and suggesting logical groupings【https://seriousben.com/posts/2025-07-splitting-large-prs-ai-era】.

## Competitors & Alternatives
| Name | Price | Gap |
|------|-------|-----|
| Kit AI Code Reviewer & Summarizer | ~$0.01-0.05 per review | Focuses on reviewing code, not splitting PRs; requires manual interpretation to act on feedback. |
| DiffEnder/pr-splitter CLI | Free | Automatically breaks up large PRs but lacks AI-driven dependency analysis and logical grouping; relies on heuristics. |
| Tessl split-pr skill | Free (via Tessl) | Suggests how to split changes but is a manual skill invocation; not integrated into PR creation workflow. |
| danielsinai/pr-splitter | Free | Shell-based splitter that creates atomic PRs but does not use AI to determine optimal splits. |
| GitHub Stacked PRs (native) | Free | Provides UI/CLI for managing stacked PRs but does not automate the decomposition; user must manually define layers. |
| AI PR summarizers (e.g., xpepper/gh-pr-summarise, usepr) | Free/Low-cost | Generate summaries of PRs but do not help split them into smaller PRs. |

## Technical Notes
- The tool will analyze a feature branch against base branch (e.g., main) using `git diff --name-only` and optionally `git diff` content.
- It will invoke an LLM (via Ollama or API) with prompts to categorize changed files into logical groups (e.g., database, API, frontend, tests) and determine dependency order.
- It will generate a bash script that creates branches, cherry-picks files, runs validation (build/test/lint), and opens stacked PRs via GitHub CLI (`gh`).
- Validation ensures each split PR can be built and tested independently.
- The tool can be run as a one-time CLI or integrated as a GitHub Action for automated suggestions on large PRs.
- Requires GitHub CLI (`gh`) and access to repository.

## Risks & Open Questions
- **Accuracy of AI grouping**: Misgrouped files could break builds; mitigation includes validation step and allowing user to adjust groupings.
- **Dependency detection**: AI may miss subtle dependencies; we can supplement with static analysis (e.g., import graphs) for critical languages.
- **User trust**: Developers may hesitate to auto-create PRs; we can provide a dry-run mode and clear commit messages.
- **Cost**: If using paid LLMs, cost per run could be a concern; we can support local models via Ollama to keep costs zero.
- **Integration with existing workflows**: Must work with various CI systems and branch protection rules.

## Sources
- https://dev.to/kelly_lewandowski_845215e/code-review-is-the-only-bottleneck-thats-growing-we-have-the-data-9e5
- https://engineering.zenity.io/p/how-to-split-large-prs-using-ai-a-practical-guide-c435
- https://github.blog/engineering/turn-one-giant-ai-generated-pull-request-to-a-reviewable-stack/
- https://seriousben.com/posts/2025-07-splitting-large-prs-ai-era/
- https://kit.cased.com/pr-reviewer/
- https://github.com/DiffEnder/pr-splitter
- https://tessl.io/registry/skills/github/stacklok/toolhive/split-pr
- https://github.com/danielsinai/pr-splitter
- https://github.com/xpepper/gh-pr-summarise
- https://github.com/flows-network/github-pr-summary
- https://pypi.org/project/usepr/