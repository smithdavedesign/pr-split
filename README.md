# PR Splitter AI — Automated pull request splitting into reviewable stacks

## Live

**https://pr-split.1426davejobs.workers.dev**

The website runs on a Cloudflare Worker, static assets on the free plan, since 2026-11-08: Vercel's account is blocked, so pr-split.vercel.app answers 402. These screenshots are of the live Worker, taken with Playwright in Chrome. pr-split itself is a CLI that runs on your machine.

| | Desktop (1440×900) | Phone (390×844) |
|---|---|---|
| The landing page: what pr-split does, the install command and a real run | <img src="docs/screenshots/live/home-desktop.png" alt="The landing page: what pr-split does, the install command and a real run, desktop" width="520"> | <img src="docs/screenshots/live/home-phone.png" alt="The landing page: what pr-split does, the install command and a real run, phone" width="200"> |
| The core action: Copy puts the install command on the clipboard | <img src="docs/screenshots/live/copied-desktop.png" alt="The core action: Copy puts the install command on the clipboard, desktop" width="520"> | <img src="docs/screenshots/live/copied-phone.png" alt="The core action: Copy puts the install command on the clipboard, phone" width="200"> |
| The privacy page: the three anonymous visit events, and who hosts the site | <img src="docs/screenshots/live/privacy-desktop.png" alt="The privacy page: the three anonymous visit events, and who hosts the site, desktop" width="520"> | <img src="docs/screenshots/live/privacy-phone.png" alt="The privacy page: the three anonymous visit events, and who hosts the site, phone" width="200"> |

## Screenshots

![The landing page: pitch, Buy button, install command, a real run, how it works, and the footer with Privacy and Terms](docs/screenshots/home-desktop.png)
The launch-ready landing page from the production build: the Buy button (placeholder payment link), the install command with its Copy button, a real run, and the footer links to Privacy and Terms.

![The landing page on a phone, with the Buy button in the header and under the pitch](docs/screenshots/home-mobile.png)
The same page on a phone (iPhone 13 viewport): it fits the screen, and Buy is in the header and under the pitch.

![The end of pr-split --execute --pr: every layer passed build and lint, was pushed, and opened as PRs #128–#131 linked as one stack](docs/screenshots/execute-pr-desktop.png)
The core action, run for real on a sample shop's 9-file branch: every layer passed `build` and `lint` before anything was pushed. Then 4 PRs were opened bottom-up, linked as a native GitHub stack, and each got a stack map.

![The PRs being opened, on a phone](docs/screenshots/execute-pr-mobile.png)
The end of the same `--execute --pr` run on a phone: the four PR URLs and the stack link.

![PR #129 as opened: summary of its files, "Depends on #128", the validated commit, and the stack-map comment](docs/screenshots/pull-request-desktop.png)
The result: PR #129 as pr-split opened it, with its files, "Depends on #128", the commit that passed validation, and the stack-map comment. GitHub is played by the local `gh` stand-in from the test suite, because the sandbox has no network.

![PR #129 on a phone](docs/screenshots/pull-request-mobile.png)
PR #129's description on a phone.

`npm run screenshots` regenerates these from a real run and the site's production build (needs `CHROMIUM_PATH`).

For developers overwhelmed by large PRs, AI analyzes changes and creates stacked, reviewable pull requests with dependency-aware splits.

- [Research](RESEARCH.md) — findings and sources
- [PRD](PRD.md)
- [Roadmap](ROADMAP.md)
- [Build notes](BUILD.md): what works today, how to run it, test status
- [Launch readiness](LAUNCH-READY.md): the website, privacy and terms pages, the Buy button, the visit beacon, and what's left before launch

```bash
npm install && npm test
node bin/pr-split.js --base main              # inside the repo you want to split; writes a dry-run pr-split.sh
node bin/pr-split.js --base main --execute    # builds the stacked branches, validating each layer
node bin/pr-split.js --base main --execute --pr --issue 123   # …then pushes them and opens one PR per layer (needs gh)
node bin/pr-split.js --base main --pr-only    # opens or updates the PRs for a stack built earlier
npm run build                                 # the website (site/) into dist/, as Vercel builds it
npm run cf:build                              # the same for the Cloudflare Worker, counted as production
```

Effort: Medium · Confidence: Medium

_Researched by the idea pipeline on 2026-10-10 ([original record](https://github.com/smithdavedesign/idea-factory/tree/main/ideas/pr-split)); repo created on David's go-ahead 2026-10-11._

## Hosting on Cloudflare Workers

Since 2026-11-08 the website is served by the `pr-split` Worker on Cloudflare (free plan): static assets only, no
Worker code. `wrangler.jsonc` serves `dist/` with `html_handling: auto-trailing-slash` (`/privacy` → `privacy.html`,
like Vercel's `cleanUrls`). Vercel ignores `wrangler.jsonc`, so both hosts build from the same code.

```bash
npm run cf:build                               # dist/, counted as production (NEXT_PUBLIC_DEPLOY_ENV=production)
provision cloudflare deploy pr-split "$PWD"    # deploy with the credential broker (token from the keychain)
provision cloudflare url pr-split              # https://pr-split.1426davejobs.workers.dev
```

The build stamps its deploy env on `<html data-deploy-env>`: `NEXT_PUBLIC_DEPLOY_ENV` from `cf:build`, else Vercel's
`VERCEL_ENV`, and the visit beacon only sends on `production`. Canonical and share URLs default to the Worker's address;
set `SITE_URL` to pin a custom domain. `STRIPE_PAYMENT_LINK` is read at build time: none is stored for pr-split, so the
Buy button stays hidden.
