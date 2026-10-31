# pr-split: launch readiness

pr-split is a local CLI. Nothing about what it does changed. Go-live adds a small public website
for it: a landing page with a Buy button, `/privacy`, `/terms`, search and share tags, and a visit
beacon for RepoHQ. It also adds the Vercel config and the `.provision` request that deploy it.

## What I did

1. **A static website in `site/`, with no new dependencies.**
   - `site/pages.mjs` renders the three pages, `robots.txt`, `sitemap.xml` and the icon.
   - `site/og-image.mjs` draws the share image.
   - `site/build.mjs` writes them all to `dist/`, together with `site/public/site.css` and
     `site/public/site.js`.
   - `npm run build` runs it. Vercel runs the same command (`vercel.json`: `outputDirectory: dist`,
     clean URLs, so `/privacy` serves `privacy.html`).
2. **Search and sharing.** Every page has:
   - its own `<title>` and meta description;
   - a canonical URL;
   - Open Graph and Twitter `summary_large_image` tags pointing at `/og.png`;
   - JSON-LD for a `SoftwareApplication` with an `Offer` of $9.00 USD, "One-time payment, no
     subscription".

   `/og.png` is a 1200×630 PNG, drawn at build time with a pixel font and rectangles and encoded by
   a small PNG writer. No image was copied from anywhere. `robots.txt` allows everything and names
   the sitemap. `sitemap.xml` lists `/`, `/privacy` and `/terms`.
3. **`/privacy` and `/terms`, linked from every footer.**
   - Privacy:
     - the CLI collects nothing and has no telemetry. It sends file paths and line counts, never
       contents, only to the Ollama server you point it at, and reaches GitHub through your own
       `gh` login;
     - the site sets no cookies;
     - the three beacon events by name, the exact fields sent, the two storage flags, and how to
       opt out;
     - Stripe handles payments;
     - contact is through GitHub issues.
   - Terms: MIT license, no warranty, **$9 paid once**, and a full refund within 30 days.
4. **Buy button.**
   - It links to `STRIPE_PAYMENT_LINK`, read at build time, and appears in the header and under the
     pitch on the landing page.
   - If the variable is unset, or isn't an `https:` URL, there is no button at all. No payment link
     or key is in the code. The build log says "Buy button shown/hidden" and never prints the link.
5. **Visit beacon** (`site/public/site.js`). It POSTs `{"slug":"pr-split","kind":…,"referrer":…}`
   as JSON to `https://idea-factory.1426davejobs.workers.dev/api/ideas/signal`, with `keepalive` and
   `credentials: "omit"`. Errors are swallowed.
   - `visit`: on every page, once per browser session (sessionStorage).
   - `activate`: **the core action is copying the install-and-run command**, with the Copy button
     or by selecting the command block and copying it. Sent once per browser (localStorage).
   - `checkout`: on every Buy click.
   - The referrer is `document.referrer` only when its origin differs from the page's; otherwise
     it is `null`.
   - Nothing is sent when:
     - `navigator.webdriver` is true;
     - the build wasn't a production build (`VERCEL_ENV`, stamped on `<html data-vercel-env>`);
     - localStorage `repohq:notrack` is set to any value;
     - storage is blocked.
6. **Deployment.**
   - `vercel.json`.
   - `.provision` asks the credential broker for the Vercel project `pr-split` and the Stripe
     payment link ($9 once).
7. **Tests.** `test/site.test.js` has 36 tests:
   - the pages render;
   - titles and descriptions are unique; canonical, OG, Twitter and JSON-LD are checked;
   - the footer links;
   - the Buy button: hidden without the env var, hidden for non-https links, escaped;
   - robots.txt and sitemap.xml, from `renderSite` and from a real build into a temp dir;
   - the PNG's header, size and pixels;
   - every beacon rule, run against a stand-in window.
8. **Screenshots.** `npm run screenshots`:
   - builds the site for production with the placeholder `STRIPE_PAYMENT_LINK=https://example.com/pay`;
   - runs pr-split for real on a sample repo;
   - serves both on localhost and captures 6 PNGs (home, the `--execute --pr` run and the PR it
     opened, each on desktop and iPhone 13);
   - removes older PNGs.

   README's Screenshots section shows them, and I opened each one to check it.
9. **`LICENSE`.** package.json already said MIT, but the file was missing, and the Terms page links
   to it.

## How to check it

```bash
npm ci --ignore-scripts && npm test            # 307 passed, 1 skipped (opt-in live Ollama test)
STRIPE_PAYMENT_LINK=https://example.com/pay npm run build    # dist/: pages, robots.txt, sitemap.xml, og.png
CHROMIUM_PATH=/path/to/chromium npm run screenshots          # docs/screenshots/*.png
```

After deploying:
- `/`, `/privacy`, `/terms`, `/robots.txt`, `/sitemap.xml` and `/og.png` all answer.
- View the page source for the tags. A share-card preview tool shows the image, and Google's Rich
  Results Test reads the JSON-LD.
- **Beacon:** on the production URL, the devtools Network tab shows one POST to
  `idea-factory.1426davejobs.workers.dev/api/ideas/signal` per session for `visit`. Copy the command for `activate`;
  click Buy for `checkout`. A preview URL sends nothing. So does a browser after
  `localStorage.setItem('repohq:notrack', '1')`.

## Decisions (made without a human; recorded here)

- **No web framework.** The repo is a CLI with no frontend. Next.js and React for three static
  pages would add a toolchain and hundreds of MB of dependencies for no behaviour. A dependency-free
  Node script renders the same things that Next's metadata, `opengraph-image`, `robots.ts` and
  `sitemap.ts` would. (Fewer moving parts; the scope check's 8-file smell is exceeded only by the
  separate CSS, JS, tests and docs.)
- **Settings are read at build time.**
  - `STRIPE_PAYMENT_LINK` and `VERCEL_ENV` are baked into static files, so the browser never needs
    a `NEXT_PUBLIC_` variable.
  - Consequence: **changing `STRIPE_PAYMENT_LINK` needs a redeploy.**
- **Canonical URLs come from**, in order:
  1. `SITE_URL`, if set;
  2. Vercel's `VERCEL_PROJECT_PRODUCTION_URL`, which is available at build time, is set even in
     previews, and is the shortest custom domain or the vercel.app one;
  3. otherwise `https://pr-split.vercel.app`.

  So a custom domain or a taken project name needs no code change.
- **"activate" = copying the install command.**
  - pr-split's real core action, splitting a branch, happens in the user's terminal. The site can't
    see it.
  - Adding telemetry to the CLI would change what it does and break the privacy page's promise.
  - Copying the command is the closest step to first use that the site can observe.
- **Every feature stays free.**
  - REVENUE.md imagines `--dry-run` free and `--execute` paid. The code gates nothing, and adding a
    license check would change what the product does.
  - So the page says plainly: everything is MIT and free, and $9 once funds it.
  - Gating, or a paid extra, is a product decision for later.
- **Refund line.** REVENUE.md gives the price, $9 one-time, but no refund policy. I chose a full
  refund within 30 days, no questions asked, requested through a GitHub issue that gives the Stripe
  receipt number and no email or card details.
- **The beacon sends `Content-Type: application/json`, as asked.** That makes the cross-origin
  request preflighted. Chrome has supported keepalive with a CORS preflight since about version 81,
  so it works as long as RepoHQ answers `OPTIONS` with CORS headers for this origin.
- **Screenshots.** The 6-PNG limit meant dropping the old dry-run "plan" shots. The landing page,
  the real `--execute --pr` run and the opened PR remain. The landing page's terminal shows lines
  from that same real run, with the earlier output marked "…".
- **LICENSE** reads "Copyright (c) 2026 the pr-split authors", because no legal name appears in the
  repo.

## What's left for David

1. **The Stripe payment link.** `.provision` requests it ("$9 once, per REVENUE.md").
   - Put it in the Vercel project's environment as **`STRIPE_PAYMENT_LINK`** (Production), then
     **redeploy**. The Buy button appears only after that.
   - Optionally set the payment link's confirmation page and a support email for receipts, so
     buyers can reply about refunds.
2. **Make `smithdavedesign/pr-split` public**, if it isn't. These all need it:
   - the install command (`npm install -g github:smithdavedesign/pr-split`);
   - the Contact and Refund route (GitHub issues);
   - the LICENSE link.
3. **A custom domain**, if wanted. Add it in Vercel, then redeploy: canonical URLs, the sitemap and
   the share image follow `VERCEL_PROJECT_PRODUCTION_URL`. That needs "Enable access to System
   Environment Variables", which is on by default. Or set `SITE_URL`.
4. **After the first real visit, check RepoHQ's count.** If it stays at zero, check that the
   endpoint answers the CORS preflight for `application/json`.
5. **Read the Terms' refund line** (30 days, via GitHub issue) and the copyright line in `LICENSE`,
   and change them if you want different ones.

## Self-review (gstack pre-landing checklist)

I reviewed `git status` and `git diff` plus every new file:
- `site/*`, `test/site.test.js`, `vercel.json`, `.provision`, `LICENSE`;
- the `scripts/screenshots.mjs` changes, README, BUILD.md, package.json and .gitignore.

**Pass 1 (CRITICAL): no findings remain.**
- SQL and data safety, and race conditions: no database or server code.
  - The beacon's once-only flags are checked and set in a single synchronous step on one JS thread.
- Unsafe HTML (XSS):
  - Every value from the environment (payment link, site URL, `VERCEL_ENV`) and every page string
    is HTML-escaped.
  - The payment link must be `https:`, so `javascript:` links are refused.
  - JSON-LD escapes `<`, so `</script>` can't break out. A test injects exactly that.
- LLM output trust boundary: the site touches no LLM output.
- Shell injection: the screenshot script runs the site build as a child process with an argument
  list, not a shell string.
- Enum completeness:
  - the three event kinds are handled in `site.js` (`visit` and `activate` once-only, `checkout`
    every time);
  - all three are named on `/privacy` and tested;
  - the screenshot names are updated everywhere; the old `plan-*` files were removed by the script,
    and nothing references them.

**Fixed during review:**
- `[P2] (confidence: 8/10) scripts/screenshots.mjs siteFile`: a request for `/..` passed the
  name check, then crashed the local screenshot server with EISDIR. The server now serves only files
  the build wrote.
- `[P3] (confidence: 9/10) site/pages.mjs siteConfig`: an empty `VERCEL_PROJECT_PRODUCTION_URL`
  produced an empty site URL instead of the default. Fixed, with a test.
- `[P3] (confidence: 9/10) scripts/screenshots.mjs`: removed an unused import, and the plan page and
  run that no shot used any more.

**Informational, left open:**
- `[P3] (confidence: 7/10)` If the sample run or the site build fails before the browser starts,
  `npm run screenshots` leaves its temp dir behind. This matches the script's existing pattern.
- `[P3] (confidence: 5/10)` Medium confidence; verify after launch. The beacon depends on RepoHQ
  answering the CORS preflight; Chrome before 81 drops it.
- `[P3] (confidence: 5/10)` There's no Content-Security-Policy header. The site has no user input
  and no third-party scripts, so this was left out for simplicity.

Sources for the two platform facts above:
- [Vercel system environment variables](https://vercel.com/docs/environment-variables/system-environment-variables)
- [Chromium issue on keepalive and CORS preflight](https://issues.chromium.org/issues/41384936)
- [blink-dev: Intent to Ship fetch keepalive](https://groups.google.com/a/chromium.org/g/blink-dev/c/8vqcABTnDF4)
