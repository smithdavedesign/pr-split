# Verdict: PASS — score 3/10

A real pain, but GitHub and the coding agents themselves are absorbing it. File-level splitting breaks builds. There is no evidence anyone would pay or install a separate tool.

## Forcing questions

### Q1 Demand reality — 3/10
All the evidence is about the problem, none about this product. The dev.to data shows review complaints growing from 3.8% to 4.8%, with PR size the top sub-theme (RESEARCH.md). The GitHub blog post says to "teach coding agents to decompose work into a clean, ordered stack", so a platform vendor is solving this inside the agent. Nobody has been shown to want a separate tool, pay for one, or be angry when a prototype breaks. The RESEARCH.md competitor table lists four free splitters (DiffEnder, danielsinai, Tessl skill, GitHub stacked PRs), which suggests the demand is real but already met for free. **Would change my mind:** a developer who has already used one of those tools and complains about a specific failure.

### Q2 Status quo — 4/10
Developers currently split by hand (`git rebase -i`, `git add -p`, `gh stack`), or just ask Claude Code, Cursor or Copilot to "split this branch into stacked PRs". That workaround costs some hours per big PR, but a prompt to the agent they already pay for is nearly free. The status quo is strong and getting better. The tool's main edge over it is the validation loop, and an agent skill can run that too.

### Q3 Desperate specificity — 2/10
The PRD's targets are "individual developers", "engineering teams" and "repository maintainers", which are categories you can't email. No named person, role or consequence appears anywhere. Candidates are a reviewer at a team adopting heavy AI coding, or an OSS maintainer who rejects 40-file PRs, but that's inference, not evidence. The people with the most pain (team leads) buy through team tooling, not a solo CLI. **Would change my mind:** one named reviewer who describes a lost week to an oversized PR.

### Q4 Narrowest wedge — 4/10
The PRD's MVP is already a pipeline (analyze, LLM grouping, branch creation, validation, `gh` PRs). The real wedge is smaller: a read-only "split plan" for one branch. That is also exactly what the Tessl skill and a plain Claude prompt do, so it has no pull on its own. Nobody pays for a plan. They'd pay for a split that builds green, and that is the hard part. Cherry-picking whole files by LLM category breaks builds whenever one file mixes concerns, and hunks are where the value is, which the PRD sets as a non-goal.

### Q5 Observation (M1 users)
Not answerable before a product exists. Watch whether M1 users (a) run it on a real, messy branch rather than a fixture, (b) accept the proposed grouping or edit it, (c) get a green build per layer without manual fixes, and (d) actually open the PRs or abandon the plan midway. Count how often files need to be split across layers.

### Q6 Future-fit — 3/10
Over three years, agents will decompose their own work into stacks, and GitHub is shipping native stacked PRs. As the platform and the agents absorb this step, a standalone splitter becomes less essential. The "AI writes more code" tailwind is shared by every competitor, including the free ones. The durable value would be a validated, hunk-level stack, but that's a research problem, not a weekend build.

## Premises
1. Large PRs are a painful bottleneck. **Supported** by the dev.to data and the GitHub blog.
2. A separate tool is the right fix. **Not supported.** GitHub and the agents are moving it into the platform, and free tools exist.
3. LLM file-level grouping yields independently buildable PRs. **Doubtful.** Cross-file dependencies are admitted as an open question in the PRD.
4. Developers will let a tool create branches and PRs automatically. **Unverified** (the PRD itself lists trust as a risk).
5. Distribution is solved. **No.** An npm/CLI route is free, but a solo CLI has no clear paid path and no waitlist hook.

## Alternatives
- **Minimal:** a Claude Code skill or prompt that proposes a split plan and runs validation (Tessl already ships this). Hours of work, no moat.
- **Extend David's PR Receipt idea** (`ideas/pr-receipt`). It has a nearer-term, measurable pain (AI token cost per PR) and a cost receipt could include "PR too large" as a signal, which covers the splitting theme at near-zero cost. A better home for this thread.
- **Ideal:** a hunk-level, build-verified stacking engine with a GitHub App. Large effort, real moat, and GitHub's own roadmap is a direct threat.
- **Lateral:** a PR-size gate Action that comments with a suggested split (read-only). Cheap, but it's still a feature of existing review tools.

## Narrowest wedge
A read-only GitHub Action that comments a suggested split plan on any PR over N files. This is the only version testable at $0. Even so, it lacks differentiation from free alternatives.

## M1 feasibility
- One person, weekend: yes, the analyzer and dry-run script are feasible.
- $0: yes with Ollama locally, Vercel Hobby for a landing page. But an LLM-backed hosted service would not be free; the free path is a local CLI only.
- The single test that proves M1: on three real branches of 20+ files, the proposed groups each build and pass tests when applied in order. I expect that to fail on at least one of three, because of mixed-concern files.
- Complexity: the full roadmap spans M1-M3 and a git/gh executor, which is beyond a lean test.

## Risks
- Platform absorption: GitHub native stacks and agents' built-in decomposition.
- Technical: file-level splits break builds, and dependency detection needs per-language static analysis.
- Four free incumbents, with no price point for a solo CLI.
- Trust: tools that rewrite branches and open PRs are risky to adopt.
- No path from an OSS/free CLI to revenue.

## Kill criteria
Drop it if any holds: (1) fewer than 5 of 50 visitors sign up in two weeks; (2) the build-verified test fails on 2 of 3 real branches; (3) GitHub's stacked-PR tooling or Claude Code ships agent-driven splitting that covers the use case; (4) nobody names a team that would pay.

## Assignment
Instead of building, find three developers who recently complained about a giant PR (Reddit, HN, dev.to comments) and ask what they did about it, and whether they tried the free splitters.
