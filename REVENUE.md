# pr-split: road to the first dollar

**Plain verdict: the evidence says nobody has been shown to pay for this.** The review scored it 3/10. Everything below is the best case, at a low price.

## Where it stands
MVP milestones M1-M3 are merged. The GOLIVE step failed on an org spend limit, so nothing is deployed. There are no legal pages, no price, no Stripe product and no users. Revenue is $0.

## Money forcing questions
**Who pays?** Not "developers". The only plausible budget holder is a senior developer or tech lead on a 2-20 person team. They review or ship 20+ file AI-generated branches every week, and they already pay for Cursor, Copilot or Claude on their own card. Team leads at larger companies buy through team tooling, so a solo CLI won't reach them. No named person exists in the evidence. Finding three is the first task.

**What do they pay today?**
- Agent subscription they already have, about $20/month. Prompting it to "split this into stacked PRs" costs nothing extra. This is the real competitor.
- Four free splitters (DiffEnder, danielsinai, the Tessl skill) and GitHub's own `gh stack`. Searches suggest it is in preview and ships an agent skill. Release status is reported inconsistently, so verify it.
- Paid stacking and review platforms: Graphite Starter about $20/user/month (Team $40), CodeRabbit Essentials about $24/user/month. These are broader products, so they are price anchors, not direct substitutes. CodeRabbit's recent plan renames come from a single aggregator.

**Narrowest version worth paying for.** A plan is free everywhere, so nobody pays for a plan. The only paid thing is a split that builds green at every layer: `--execute` with per-layer validation, plus PR opening. The free tier is `--dry-run`. If a split can't pass build/test on real branches, there is no product.

## Price
**$9 one-time**, through a Stripe Checkout payment link. It's below the monthly cost of anything else the buyer pays for, so it is an impulse buy. A subscription isn't justified: the tool is local, with no hosted cost, and nobody has shown recurring use. This price is a test of willingness to pay, not a revenue model. At $9, ten buyers is $90.

## Shortest path
1. **Prove it works (days).** Run it on three real branches of 20+ files. If two fail to build green, stop here (kill criterion 2).
2. **Deploy and make it launch-ready.** Get past the spend limit, put a landing page on a free tier, add privacy and terms pages and screenshots of the main flow. David creates the Stripe product and payment link.
3. **Find three complainers first.** Search dev.to comments, Hacker News and r/ClaudeAI for people griping about giant AI PRs. Offer a free run on their branch and ask whether they tried the free splitters. This is the review's assignment, and it is the cheapest evidence available.
4. **Launch.** One Show HN and one r/ClaudeAI post. Hand-fulfil the first ten purchases: the Stripe success page links to the paid build or a key.
5. **Ask.** Charge the people whose branches came out green.

## Positioning
It does the decomposition that `gh stack` and agents don't do reliably. `gh stack` manages the stack afterwards, so you don't compete with it.

## Risks
- No demand evidence; the free alternatives are good enough for most.
- GitHub and the agents are absorbing the feature (the review's Q6).
- File-level splitting breaks builds on mixed-concern files.
- Trust in a tool that creates branches and PRs.
- The $9 price may be too low to be worth the support burden, and too high for a free-tool crowd.

## Kill criteria
Stop if any holds:
- Under 5 of 50 visitors sign up in two weeks.
- The build-verified test fails on 2 of 3 real branches.
- None of the first ~20 people contacted agrees to pay $9 within 30 days.
- GitHub or Claude Code ships agent-driven splitting that covers the use case.

## Cheaper alternative
The review suggested folding this into `ideas/pr-receipt`, where a "PR too large" signal costs almost nothing to add. If step 1 or 3 goes badly, do that instead.

## Sources
- [Graphite pricing summary](https://stackpick.net/pricing/graphite/)
- [CodeRabbit pricing](https://aicodereview.cc/blog/coderabbit-pricing)
- [gh-stack](https://github.github.com/gh-stack/)
- [gh-stack releases](https://github.com/github/gh-stack/releases)
