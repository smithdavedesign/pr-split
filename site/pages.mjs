// The public website, rendered at build time: the landing page, /privacy and /terms, plus
// robots.txt, sitemap.xml and the icon. pr-split itself is a CLI; this site only describes it and
// sells it. Settings come from the build environment (see siteConfig); nothing here is secret.
import { createRequire } from 'node:module';
import { HEIGHT as IMAGE_HEIGHT, WIDTH as IMAGE_WIDTH } from './og-image.mjs';

const { version } = createRequire(import.meta.url)('../package.json');

export const DEFAULT_SITE_URL = 'https://pr-split.vercel.app';
export const REPO_URL = 'https://github.com/smithdavedesign/pr-split';
export const ISSUES_URL = `${REPO_URL}/issues`;
export const SIGNAL_URL = 'https://repohq.vercel.app/api/ideas/signal';
export const PRICE = { amount: '9.00', currency: 'USD', label: '$9' };
export const REFUND_DAYS = 30;
export const SHARE_IMAGE = {
  path: '/og.png',
  width: IMAGE_WIDTH,
  height: IMAGE_HEIGHT,
  alt: 'pr-split: split one giant branch into small PRs that each build green. A stack of four validated PRs on main.',
};
const UPDATED = '30 October 2026';
const INSTALL = ['npm install -g github:smithdavedesign/pr-split', 'pr-split --base main'];

/** An absolute http(s) URL's origin, or null. */
function originOf(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The Stripe payment link, if it is an https URL; anything else hides the Buy button. */
export function paymentLink(value) {
  const link = value?.trim();
  if (!link) return null;
  try {
    return new URL(link).protocol === 'https:' ? link : null;
  } catch {
    return null;
  }
}

/**
 * Build settings from the environment:
 * - STRIPE_PAYMENT_LINK: the Buy button's target; unset (or not https) hides the button.
 * - VERCEL_ENV: only "production" sends the RepoHQ beacon; previews and local builds don't.
 * - SITE_URL, else VERCEL_PROJECT_PRODUCTION_URL (Vercel's production domain): canonical URLs.
 */
export function siteConfig(env = {}) {
  const productionHost = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const siteUrl =
    originOf(env.SITE_URL?.trim()) ?? (productionHost ? originOf(`https://${productionHost}`) : null) ?? DEFAULT_SITE_URL;
  return {
    siteUrl,
    paymentLink: paymentLink(env.STRIPE_PAYMENT_LINK),
    paymentLinkInvalid: Boolean(env.STRIPE_PAYMENT_LINK?.trim()) && !paymentLink(env.STRIPE_PAYMENT_LINK),
    vercelEnv: env.VERCEL_ENV?.trim() || 'development',
  };
}

const esc = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** JSON for a <script> data block: `<` is escaped so no value can close the element. */
const scriptJson = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');

function softwareApplication(config) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'pr-split',
    description: PAGES[0].description,
    url: `${config.siteUrl}/`,
    image: `${config.siteUrl}${SHARE_IMAGE.path}`,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, macOS',
    softwareVersion: version,
    license: 'https://opensource.org/licenses/MIT',
    offers: {
      '@type': 'Offer',
      price: PRICE.amount,
      priceCurrency: PRICE.currency,
      description: 'One-time payment, no subscription',
      ...(config.paymentLink ? { url: config.paymentLink } : {}),
    },
  };
}

const buy = (config, label, className) =>
  config.paymentLink ? `<a class="${className}" href="${esc(config.paymentLink)}" data-buy>${esc(label)}</a>` : '';

function layout(page, config, main) {
  const url = `${config.siteUrl}${page.path}`;
  const image = `${config.siteUrl}${SHARE_IMAGE.path}`;
  return `<!doctype html>
<html lang="en" data-vercel-env="${esc(config.vercelEnv)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css">
<meta property="og:type" content="website">
<meta property="og:site_name" content="pr-split">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${SHARE_IMAGE.width}">
<meta property="og:image:height" content="${SHARE_IMAGE.height}">
<meta property="og:image:alt" content="${esc(SHARE_IMAGE.alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(page.title)}">
<meta name="twitter:description" content="${esc(page.description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="twitter:image:alt" content="${esc(SHARE_IMAGE.alt)}">
<script type="application/ld+json">${scriptJson(softwareApplication(config))}</script>
<script type="module" src="/site.js"></script>
</head>
<body>
<header class="top"><div class="wrap">
<a class="brand" href="/"><span class="prompt">$</span> pr-split</a>
<nav><a class="hide-narrow" href="/#how">How it works</a><a href="${REPO_URL}">GitHub</a>${buy(config, `Buy — ${PRICE.label}`, 'buy buy-small')}</nav>
</div></header>
<main class="wrap">
${main.trim()}
</main>
<footer class="foot"><div class="wrap">
<span>pr-split ${esc(version)} · MIT license</span>
<nav><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${ISSUES_URL}">Contact (GitHub issues)</a><a href="${REPO_URL}">Source</a></nav>
</div></footer>
</body>
</html>
`;
}

/** The end of a real `--execute --pr` run on the sample repo from docs/screenshots (README). */
const RUN_EXCERPT = [
  ['cmd', '$ pr-split --base main --execute --pr --issue 42'],
  ['dim', '… the plan; then each layer is built on the one below it, passes build and lint, and is pushed …'],
  ['pr', 'pr-split: opened #128 pr-split/01-database → main: https://github.com/acme/shop/pull/128'],
  ['pr', 'pr-split: opened #129 pr-split/02-api → pr-split/01-database: https://github.com/acme/shop/pull/129'],
  ['pr', 'pr-split: opened #130 pr-split/03-ui → pr-split/02-api: https://github.com/acme/shop/pull/130'],
  ['pr', 'pr-split: opened #131 pr-split/04-docs → pr-split/03-ui: https://github.com/acme/shop/pull/131'],
  ['ok', 'pr-split: linked #128 #129 #130 #131 as GitHub stack 7'],
  ['ok', 'pr-split: stack map posted on #128 #129 #130 #131'],
  ['ok', 'pr-split: 4 stacked PRs into main; review and merge them bottom-up: #128, #129, #130, #131'],
];

function home(config) {
  const cta = config.paymentLink
    ? `<p class="cta">${buy(config, `Buy pr-split — ${PRICE.label} once`, 'buy')}</p>
<p class="small">Every feature is free and MIT-licensed. If pr-split saved you a review cycle, ${PRICE.label} once funds it. No subscription; refund within ${REFUND_DAYS} days (<a href="/terms">terms</a>).</p>`
    : '<p class="small">Free and MIT-licensed.</p>';
  return `
<section class="hero">
<div>
<h1>Split one giant branch into small PRs that each build green.</h1>
<p class="lede">pr-split groups your branch's changed files into layers (database, API, UI, docs), builds each layer on the one below it, runs your build, test and lint on every layer, then opens them on GitHub as a linked stack of pull requests.</p>
${cta}
</div>
<div>
<div class="install"><pre id="install" data-command>${INSTALL.map(esc).join('\n')}</pre><button type="button" class="copy" data-copy="install" hidden>Copy</button></div>
<p class="small">The second line is a dry run: it prints the plan, writes <code>pr-split.sh</code> and changes nothing. Add <code>--execute --pr</code> to build, check, push and open the PRs.</p>
<figure class="term"><figcaption>A real run on a sample shop's 9-file branch</figcaption><pre>${RUN_EXCERPT.map(([kind, line]) => `<span class="${kind}">${esc(line)}</span>`).join('\n')}</pre></figure>
</div>
</section>
<section id="how" class="steps">
<div><h2>1. Plan</h2><p>Groups the files by concern with a local Ollama model, or by their paths. Shows each layer's branch, files and line counts. Read-only.</p></div>
<div><h2>2. Build and check</h2><p><code>--execute</code> makes one branch per layer, each one commit on the layer below, and runs your checks on each. A file that mixes concerns can fail a layer: it stops there and pushes nothing.</p></div>
<div><h2>3. Open the stack</h2><p><code>--pr</code> pushes and opens one PR per layer with your own <code>gh</code> login, each with its dependencies, a file summary and a stack map. Re-runs update the same PRs.</p></div>
<div><h2>What it needs</h2><p>Node 20.10+, git and bash. The GitHub CLI for PRs. Ollama is optional. It runs on your machine and sends your code nowhere.</p></div>
</section>`;
}

function privacy() {
  return `
<article class="doc">
<h1>Privacy</h1>
<p class="small">Last updated ${UPDATED}</p>
<p><strong>Short version: pr-split collects nothing. This website sets no cookies and counts three anonymous events.</strong></p>

<h2>The pr-split CLI</h2>
<p>pr-split runs on your computer. It has no telemetry and sends nothing to us.</p>
<ul>
<li>It reads your repository with git, and only changes it when you pass <code>--execute</code>.</li>
<li>To group files it asks the Ollama server at <code>OLLAMA_HOST</code>, which is your own machine (127.0.0.1:11434) unless you change it. It sends the changed file paths, their change types and line counts, never file contents. <code>--no-llm</code> skips Ollama.</li>
<li>With <code>--pr</code> or <code>--pr-only</code> it uses your own <code>gh</code> login to push your branches and open pull requests in your repository. pr-split never reads your GitHub token.</li>
</ul>

<h2>This website</h2>
<ul>
<li>No cookies, no accounts, no forms, no ads and no third-party analytics.</li>
<li>One small script tells RepoHQ, the maintainer's dashboard of how each of their projects is used, when one of three things happens:
<ul>
<li><code>visit</code>: you open a page of this site (at most once per browser session);</li>
<li><code>activate</code>: you copy the install command for the first time (at most once per browser);</li>
<li><code>checkout</code>: you click Buy.</li>
</ul></li>
<li>Each event is one request to <code>${SIGNAL_URL}</code> carrying exactly three things: the product name (<code>pr-split</code>), the event name, and the address of the other website that linked you here, if any. Links within this site are never sent. It carries no cookie and no identifier.</li>
<li>So that each event is counted once, the script keeps a flag in your browser's session storage (<code>visit</code>) and local storage (<code>activate</code>). These flags never leave your browser.</li>
<li>Nothing is sent from automated browsers, from preview deployments, or from a browser where local storage has <code>repohq:notrack</code> set. To opt out, run <code>localStorage.setItem('repohq:notrack', '1')</code> in your browser's console on this site.</li>
<li>As with any website, the servers that answer (Vercel hosts this site, and RepoHQ) receive your IP address and browser type with each request. See <a href="https://vercel.com/legal/privacy-policy">Vercel's privacy policy</a>.</li>
</ul>

<h2>Payments</h2>
<p>If you buy, you pay on Stripe's checkout page. Stripe handles your card; we never see it. We receive the payment record Stripe gives every seller, such as your email address and the amount, and use it only for your receipt and refunds. See <a href="https://stripe.com/privacy">Stripe's privacy policy</a>.</p>

<h2>Contact</h2>
<p>Questions, or a request to delete your payment record: open an issue at <a href="${ISSUES_URL}">${ISSUES_URL.replace('https://', '')}</a>. Issues are public, so leave out personal details.</p>
</article>`;
}

function terms() {
  return `
<article class="doc">
<h1>Terms</h1>
<p class="small">Last updated ${UPDATED}</p>

<h2>The software</h2>
<p>pr-split is open source under the <a href="${REPO_URL}/blob/main/LICENSE">MIT license</a>. You may use, copy and change it, whether or not you pay.</p>

<h2>No warranty</h2>
<p>pr-split is provided "as is", without warranty of any kind, express or implied, including fitness for a particular purpose. When you ask it to (<code>--execute</code>, <code>--pr</code>, <code>--pr-only</code>), it creates branches, pushes them and opens pull requests. Read the dry-run plan first and review what it pushes; you are responsible for your repositories. To the extent the law allows, the maintainer is not liable for any loss or damage from using pr-split, and never for more than you paid for it.</p>

<h2>Price and refunds</h2>
<ul>
<li>pr-split costs <strong>${PRICE.label} (US dollars), paid once</strong> through Stripe. No subscription, no renewals.</li>
<li>Every feature works the same whether or not you pay; the payment funds pr-split's development.</li>
<li><strong>Refunds: ask within ${REFUND_DAYS} days of buying and you get the full ${PRICE.label} back, no questions asked.</strong> Open an issue titled "Refund" at <a href="${ISSUES_URL}">${ISSUES_URL.replace('https://', '')}</a> with your Stripe receipt number, and leave out your email address and card details.</li>
</ul>

<h2>Changes</h2>
<p>If these terms change, the date above changes. A purchase keeps the terms that applied when you paid.</p>

<h2>Contact</h2>
<p>Open an issue at <a href="${ISSUES_URL}">${ISSUES_URL.replace('https://', '')}</a>.</p>
</article>`;
}

/** The public pages, in sitemap order. Each has its own title and description. */
export const PAGES = [
  {
    path: '/',
    file: 'index.html',
    title: 'pr-split: split a giant branch into stacked PRs that each build green',
    description:
      'A local CLI that splits a big feature branch into small stacked PRs: it groups the files into layers, checks that each layer builds, then opens them on GitHub.',
    render: home,
  },
  {
    path: '/privacy',
    file: 'privacy.html',
    title: 'Privacy · pr-split',
    description:
      "What pr-split collects: the CLI collects nothing, and its website sets no cookies and counts three anonymous events (visit, activate, checkout).",
    render: privacy,
  },
  {
    path: '/terms',
    file: 'terms.html',
    title: 'Terms · pr-split',
    description: `pr-split's terms: MIT-licensed software with no warranty, ${PRICE.label} paid once through Stripe, and a full refund within ${REFUND_DAYS} days.`,
    render: terms,
  },
];

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="6" fill="#0d1117"/>
<rect x="6" y="6" width="20" height="4" rx="1" fill="#3fb950"/>
<rect x="6" y="12" width="20" height="4" rx="1" fill="#f0883e"/>
<rect x="6" y="18" width="20" height="4" rx="1" fill="#bc8cff"/>
<rect x="6" y="24" width="20" height="4" rx="1" fill="#58a6ff"/>
</svg>
`;

/** Every generated text file of the site, by output path. */
export function renderSite(config) {
  const files = {};
  for (const page of PAGES) files[page.file] = layout(page, config, page.render(config));
  files['robots.txt'] = `User-agent: *\nAllow: /\n\nSitemap: ${config.siteUrl}/sitemap.xml\n`;
  files['sitemap.xml'] = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map((page) => `  <url><loc>${esc(`${config.siteUrl}${page.path}`)}</loc></url>`).join('\n')}
</urlset>
`;
  files['favicon.svg'] = FAVICON;
  return files;
}
