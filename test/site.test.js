// The public website (site/): pages, search and share tags, robots.txt and the sitemap, the Buy
// button's env var, the share image, and the RepoHQ beacon's rules (site/public/site.js).
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OUT, buildSite } from '../site/build.mjs';
import { HEIGHT, WIDTH, createCanvas, encodePng } from '../site/og-image.mjs';
import { DEFAULT_SITE_URL, ISSUES_URL, PAGES, SIGNAL_URL, renderSite, siteConfig } from '../site/pages.mjs';
import * as beacon from '../site/public/site.js';

const ROOT = new URL('..', import.meta.url);
const PAY = 'https://example.com/pay';
const PRODUCTION = { VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'pr-split.vercel.app' };

const decode = (text) =>
  text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
const title = (html) => decode(html.match(/<title>(.*?)<\/title>/)[1]);
const meta = (html, key) => {
  const found = html.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)">`));
  return found && decode(found[1]);
};
const canonical = (html) => decode(html.match(/<link rel="canonical" href="([^"]*)">/)[1]);
const jsonLd = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
const buyLinks = (html) => [...html.matchAll(/<a class="buy[^"]*" href="([^"]*)" data-buy>/g)].map((m) => decode(m[1]));
const footer = (html) => html.slice(html.indexOf('<footer'));

describe('pages', () => {
  const config = siteConfig({ ...PRODUCTION, STRIPE_PAYMENT_LINK: PAY });
  const files = renderSite(config);

  it('renders the landing page, /privacy and /terms', () => {
    expect(PAGES.map((p) => [p.path, p.file])).toEqual([
      ['/', 'index.html'],
      ['/privacy', 'privacy.html'],
      ['/terms', 'terms.html'],
    ]);
    for (const page of PAGES) {
      expect(files[page.file]).toMatch(/^<!doctype html>\n<html lang="en"/);
      expect(files[page.file]).toContain('</main>');
    }
    expect(files['index.html']).toContain('<h1>Split one giant branch into small PRs that each build green.</h1>');
    expect(files['privacy.html']).toContain('<h1>Privacy</h1>');
    expect(files['terms.html']).toContain('<h1>Terms</h1>');
  });

  it('gives every page its own title and description, a canonical URL, and share tags with the 1200×630 image', () => {
    const titles = new Set();
    const descriptions = new Set();
    for (const page of PAGES) {
      const html = files[page.file];
      const url = `https://pr-split.vercel.app${page.path}`;
      titles.add(title(html));
      descriptions.add(meta(html, 'description'));
      expect(title(html)).toBe(page.title);
      expect(meta(html, 'description')).toBe(page.description);
      expect(page.description.length).toBeGreaterThan(50);
      expect(page.description.length).toBeLessThanOrEqual(160);
      expect(canonical(html)).toBe(url);
      expect(meta(html, 'og:url')).toBe(url);
      expect(meta(html, 'og:type')).toBe('website');
      expect(meta(html, 'og:title')).toBe(page.title);
      expect(meta(html, 'og:description')).toBe(page.description);
      expect(meta(html, 'og:image')).toBe('https://pr-split.vercel.app/og.png');
      expect(meta(html, 'og:image:width')).toBe(String(WIDTH));
      expect(meta(html, 'og:image:height')).toBe(String(HEIGHT));
      expect(meta(html, 'og:image:alt')).toBeTruthy();
      expect(meta(html, 'twitter:card')).toBe('summary_large_image');
      expect(meta(html, 'twitter:title')).toBe(page.title);
      expect(meta(html, 'twitter:description')).toBe(page.description);
      expect(meta(html, 'twitter:image')).toBe('https://pr-split.vercel.app/og.png');
    }
    expect(titles.size).toBe(PAGES.length);
    expect(descriptions.size).toBe(PAGES.length);
    expect([WIDTH, HEIGHT]).toEqual([1200, 630]);
  });

  it('describes pr-split as a SoftwareApplication with a $9 one-time Offer on every page', () => {
    for (const page of PAGES) {
      const data = jsonLd(files[page.file]);
      expect(data).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'pr-split',
        url: 'https://pr-split.vercel.app/',
        applicationCategory: 'DeveloperApplication',
        offers: { '@type': 'Offer', price: '9.00', priceCurrency: 'USD', url: PAY },
      });
    }
  });

  it('links Privacy and Terms from every footer', () => {
    for (const page of PAGES) {
      const foot = footer(files[page.file]);
      expect(foot).toContain('<a href="/privacy">Privacy</a>');
      expect(foot).toContain('<a href="/terms">Terms</a>');
      expect(foot).toContain(`<a href="${ISSUES_URL}">`);
    }
  });

  it('shows the Buy button, linking to STRIPE_PAYMENT_LINK, in the header and on the landing page', () => {
    expect(buyLinks(files['index.html'])).toEqual([PAY, PAY]);
    expect(buyLinks(files['privacy.html'])).toEqual([PAY]);
    expect(buyLinks(files['terms.html'])).toEqual([PAY]);
    expect(files['index.html']).toContain('Buy pr-split — $9 once</a>');
  });

  it('hides the Buy button when STRIPE_PAYMENT_LINK is unset', () => {
    const free = renderSite(siteConfig(PRODUCTION));
    for (const page of PAGES) {
      expect(buyLinks(free[page.file])).toEqual([]);
      expect(free[page.file]).not.toContain('data-buy');
      expect(free[page.file]).not.toMatch(/>Buy\b/);
      expect(jsonLd(free[page.file]).offers).toEqual({
        '@type': 'Offer',
        price: '9.00',
        priceCurrency: 'USD',
        description: 'One-time payment, no subscription',
      });
    }
  });

  it('hides the Buy button for a link that is not an https URL', () => {
    for (const link of ['http://example.com/pay', 'javascript:alert(1)', 'buy.stripe.com/x', 'not a url']) {
      const settings = siteConfig({ STRIPE_PAYMENT_LINK: link });
      expect(settings.paymentLink, link).toBeNull();
      expect(settings.paymentLinkInvalid, link).toBe(true);
      expect(renderSite(settings)['index.html']).not.toContain('data-buy');
    }
    expect(siteConfig({ STRIPE_PAYMENT_LINK: '  ' })).toMatchObject({ paymentLink: null, paymentLinkInvalid: false });
    expect(siteConfig({ STRIPE_PAYMENT_LINK: ` ${PAY}\n` }).paymentLink).toBe(PAY);
  });

  it('escapes the payment link, so it cannot break out of the attribute or the JSON-LD block', () => {
    const link = 'https://example.com/pay?a=1&b="x"</script><script>alert(1)</script>';
    const html = renderSite(siteConfig({ STRIPE_PAYMENT_LINK: link }))['index.html'];
    expect(buyLinks(html)).toEqual([link, link]);
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(jsonLd(html).offers.url).toBe(link);
  });

  it('takes canonical URLs from SITE_URL, else the Vercel production domain, else the default', () => {
    expect(siteConfig({}).siteUrl).toBe(DEFAULT_SITE_URL);
    expect(siteConfig({ VERCEL_PROJECT_PRODUCTION_URL: 'pr-split-abc.vercel.app' }).siteUrl).toBe('https://pr-split-abc.vercel.app');
    expect(siteConfig({ SITE_URL: 'https://prsplit.dev/', VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' }).siteUrl).toBe('https://prsplit.dev');
    expect(siteConfig({ SITE_URL: 'ftp://nope' }).siteUrl).toBe(DEFAULT_SITE_URL);
    expect(siteConfig({ SITE_URL: '', VERCEL_PROJECT_PRODUCTION_URL: '' }).siteUrl).toBe(DEFAULT_SITE_URL);
    const html = renderSite(siteConfig({ SITE_URL: 'https://prsplit.dev' }))['terms.html'];
    expect(canonical(html)).toBe('https://prsplit.dev/terms');
    expect(meta(html, 'og:image')).toBe('https://prsplit.dev/og.png');
  });

  it("stamps VERCEL_ENV on every page; only production turns the beacon on", () => {
    expect(files['index.html']).toContain('<html lang="en" data-vercel-env="production">');
    expect(renderSite(siteConfig({ VERCEL_ENV: 'preview' }))['privacy.html']).toContain('data-vercel-env="preview"');
    expect(renderSite(siteConfig({}))['terms.html']).toContain('data-vercel-env="development"');
    for (const page of PAGES) expect(files[page.file]).toContain('<script type="module" src="/site.js"></script>');
  });

  it('wires the copy button to the install command', () => {
    const html = files['index.html'];
    expect(html).toContain('<pre id="install" data-command>npm install -g github:smithdavedesign/pr-split\npr-split --base main</pre>');
    expect(html).toContain('<button type="button" class="copy" data-copy="install" hidden>Copy</button>');
  });

  it('says on /privacy what is collected, names the three events and how to opt out', () => {
    const html = files['privacy.html'];
    expect(html).toContain('pr-split collects nothing');
    expect(html).toContain('No cookies');
    for (const kind of ['visit', 'activate', 'checkout']) expect(html).toContain(`<code>${kind}</code>`);
    expect(html).toContain(SIGNAL_URL);
    expect(html).toContain('repohq:notrack');
    expect(html).toContain(ISSUES_URL);
  });

  it('says on /terms: no warranty, $9 once, the refund window and how to ask', () => {
    const html = files['terms.html'];
    expect(html).toContain('without warranty of any kind');
    expect(html).toContain('$9 (US dollars), paid once');
    expect(html).toContain('ask within 30 days of buying and you get the full $9 back');
    expect(html).toContain(ISSUES_URL);
  });

  it('posts to the same RepoHQ endpoint the privacy page names', () => {
    expect(beacon.SIGNAL_URL).toBe(SIGNAL_URL);
    expect(beacon.SLUG).toBe('pr-split');
  });
});

describe('robots.txt and sitemap.xml', () => {
  const files = renderSite(siteConfig(PRODUCTION));

  it('allows indexing and points at the sitemap', () => {
    const robots = files['robots.txt'];
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Allow: \/$/m);
    expect(robots).not.toMatch(/^Disallow: \/\s*$/m);
    expect(robots).toMatch(/^Sitemap: https:\/\/pr-split\.vercel\.app\/sitemap\.xml$/m);
  });

  it('lists exactly the public pages, at their canonical URLs', () => {
    const urls = [...files['sitemap.xml'].matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    expect(urls).toEqual(['https://pr-split.vercel.app/', 'https://pr-split.vercel.app/privacy', 'https://pr-split.vercel.app/terms']);
    expect(urls).toEqual(PAGES.map((page) => canonical(files[page.file])));
    expect(files['sitemap.xml']).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  });
});

describe('the build (npm run build)', () => {
  let out;
  const lines = [];
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), 'pr-split-site-'));
    buildSite({ env: { ...PRODUCTION, STRIPE_PAYMENT_LINK: PAY }, outDir: out, log: (line) => lines.push(line) });
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('writes the pages, robots.txt, sitemap.xml, the share image and the assets', () => {
    expect(readdirSync(out).sort()).toEqual(
      ['favicon.svg', 'index.html', 'og.png', 'privacy.html', 'robots.txt', 'site.css', 'site.js', 'sitemap.xml', 'terms.html'].sort(),
    );
    expect(readFileSync(join(out, 'robots.txt'), 'utf8')).toContain('Sitemap: https://pr-split.vercel.app/sitemap.xml');
    expect(readFileSync(join(out, 'sitemap.xml'), 'utf8')).toContain('<loc>https://pr-split.vercel.app/privacy</loc>');
    expect(buyLinks(readFileSync(join(out, 'index.html'), 'utf8'))).toEqual([PAY, PAY]);
  });

  it('draws a 1200×630 PNG share image', () => {
    const png = readFileSync(join(out, 'og.png'));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([1200, 630, 8, 2]);
    const idat = png.indexOf('IDAT');
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
    expect(raw.length).toBe((1200 * 3 + 1) * 630);
    const colours = new Set();
    for (let i = 1; i < raw.length; i += 3 * 97) colours.add(raw.readUIntBE(i, 3));
    expect(colours.size).toBeGreaterThan(3);
    expect(png.length).toBeLessThan(200_000);
  });

  it('says whether the Buy button and the beacon are on, without printing the link', () => {
    expect(lines.join('\n')).toContain('Buy button shown');
    expect(lines.join('\n')).toContain('beacon on');
    expect(lines.join('\n')).not.toContain(PAY);
    const quiet = [];
    const dir = mkdtempSync(join(tmpdir(), 'pr-split-site-'));
    try {
      buildSite({ env: { VERCEL_ENV: 'preview', STRIPE_PAYMENT_LINK: 'javascript:alert(1)' }, outDir: dir, log: (l) => quiet.push(l) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(quiet.join('\n')).toContain("STRIPE_PAYMENT_LINK isn't an https URL");
    expect(quiet.join('\n')).toContain('Buy button hidden');
    expect(quiet.join('\n')).toContain('beacon off (VERCEL_ENV is preview)');
    expect(quiet.join('\n')).not.toContain('javascript:');
  });

  it('matches vercel.json: npm run build writes dist/, served with clean URLs', () => {
    const vercel = JSON.parse(readFileSync(new URL('vercel.json', ROOT), 'utf8'));
    const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
    expect(vercel).toMatchObject({ buildCommand: 'npm run build', outputDirectory: 'dist', cleanUrls: true });
    expect(pkg.scripts.build).toBe('node site/build.mjs');
    expect(basename(DEFAULT_OUT)).toBe(vercel.outputDirectory);
    expect(pkg.files).not.toContain('site');
  });
});

describe('share image drawing', () => {
  it('encodes exactly the pixels drawn', () => {
    const canvas = createCanvas(2, 1, '#000000');
    canvas.fill(1, 0, 1, 1, '#ff8000');
    const png = encodePng(canvas);
    const idat = png.indexOf('IDAT');
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
    expect([...raw]).toEqual([0, 0, 0, 0, 255, 128, 0]);
  });

  it('refuses text it has no glyph for, instead of drawing a gap', () => {
    expect(() => createCanvas(10, 10, '#000000').text('é', 0, 0, 1, '#ffffff')).toThrow('no glyph for "é"');
  });
});

// --- The beacon, against a stand-in window -----------------------------------------------------

const ORIGIN = 'https://pr-split.vercel.app';
function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)) };
}
function element(extra = {}) {
  const listeners = {};
  return { listeners, dataset: {}, hidden: true, textContent: '', addEventListener: (type, fn) => (listeners[type] = fn), ...extra };
}
function fakeWindow({ env = 'production', webdriver = false, referrer = '', local = storage(), session = storage(), elements = {}, clipboard } = {}) {
  const byId = Object.fromEntries(Object.values(elements).flat().filter((e) => e.id).map((e) => [e.id, e]));
  return {
    document: {
      documentElement: { dataset: env === null ? {} : { vercelEnv: env } },
      referrer,
      querySelectorAll: (selector) => elements[selector] ?? [],
      getElementById: (id) => byId[id] ?? null,
    },
    navigator: { webdriver, clipboard },
    location: { origin: ORIGIN },
    localStorage: local,
    sessionStorage: session,
    fetch: vi.fn(() => Promise.resolve()),
    setTimeout: vi.fn(),
  };
}
const sent = (win) => win.fetch.mock.calls.map(([, init]) => JSON.parse(init.body));

describe('beacon (site/public/site.js)', () => {
  it('POSTs {slug, kind, referrer} as JSON to RepoHQ, keepalive and without cookies', () => {
    const win = fakeWindow();
    expect(beacon.signal(win, 'visit')).toBe(true);
    expect(win.fetch).toHaveBeenCalledWith('https://repohq.vercel.app/api/ideas/signal', {
      method: 'POST',
      keepalive: true,
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'pr-split', kind: 'visit', referrer: null }),
    });
  });

  it('sends "visit" once per browser session', () => {
    const local = storage();
    const win = fakeWindow({ local });
    beacon.signal(win, 'visit');
    expect(beacon.signal(win, 'visit')).toBe(false);
    expect(sent(win)).toHaveLength(1);
    const nextSession = fakeWindow({ local, session: storage() });
    expect(beacon.signal(nextSession, 'visit')).toBe(true);
  });

  it('sends "activate" once per browser, even across sessions', () => {
    const local = storage();
    const first = fakeWindow({ local });
    expect(beacon.signal(first, 'activate')).toBe(true);
    expect(beacon.signal(first, 'activate')).toBe(false);
    expect(beacon.signal(fakeWindow({ local, session: storage() }), 'activate')).toBe(false);
    expect(sent(first)).toEqual([{ slug: 'pr-split', kind: 'activate', referrer: null }]);
  });

  it('sends "checkout" on every click', () => {
    const win = fakeWindow();
    beacon.signal(win, 'checkout');
    beacon.signal(win, 'checkout');
    expect(sent(win).map((s) => s.kind)).toEqual(['checkout', 'checkout']);
  });

  it('sends the referrer only when it is another site', () => {
    expect(beacon.externalReferrer('https://news.ycombinator.com/item?id=1', ORIGIN)).toBe('https://news.ycombinator.com/item?id=1');
    expect(beacon.externalReferrer(`${ORIGIN}/terms?shared=1`, ORIGIN)).toBeNull();
    expect(beacon.externalReferrer('', ORIGIN)).toBeNull();
    expect(beacon.externalReferrer('not a url', ORIGIN)).toBeNull();
    const win = fakeWindow({ referrer: 'https://www.reddit.com/r/ClaudeAI/' });
    beacon.signal(win, 'visit');
    expect(sent(win)[0].referrer).toBe('https://www.reddit.com/r/ClaudeAI/');
    const inside = fakeWindow({ referrer: `${ORIGIN}/privacy` });
    beacon.signal(inside, 'checkout');
    expect(sent(inside)[0].referrer).toBeNull();
  });

  it.each([
    ['a preview deployment', { env: 'preview' }],
    ['a local build', { env: 'development' }],
    ['a page without the stamp', { env: null }],
    ['an automated browser', { webdriver: true }],
    ['the owner (repohq:notrack set)', { local: storage({ 'repohq:notrack': '1' }) }],
    ['repohq:notrack set to an empty string', { local: storage({ 'repohq:notrack': '' }) }],
  ])('sends nothing from %s', (_, options) => {
    const win = fakeWindow(options);
    for (const kind of ['visit', 'activate', 'checkout']) expect(beacon.signal(win, kind)).toBe(false);
    expect(win.fetch).not.toHaveBeenCalled();
  });

  it('sends nothing when storage is blocked, and never throws when the request fails', () => {
    const blocked = fakeWindow();
    blocked.localStorage = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => {} };
    expect(beacon.signal(blocked, 'visit')).toBe(false);
    expect(blocked.fetch).not.toHaveBeenCalled();

    const sessionBlocked = fakeWindow();
    sessionBlocked.sessionStorage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } };
    expect(beacon.signal(sessionBlocked, 'visit')).toBe(false);

    const offline = fakeWindow();
    offline.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(beacon.signal(offline, 'visit')).toBe(true);
    const broken = fakeWindow();
    broken.fetch = vi.fn(() => { throw new TypeError('keepalive not supported'); });
    expect(() => beacon.signal(broken, 'checkout')).not.toThrow();
  });

  it('on page load: counts the visit, Buy clicks as checkout, and copying the install command as activate', async () => {
    const buy = element();
    const command = element({ id: 'install', textContent: 'npm install -g github:smithdavedesign/pr-split\npr-split --base main' });
    const button = element({ dataset: { copy: 'install' } });
    const writeText = vi.fn(() => Promise.resolve());
    const win = fakeWindow({
      referrer: 'https://news.ycombinator.com/',
      elements: { '[data-buy]': [buy], '[data-command]': [command], '[data-copy]': [button] },
      clipboard: { writeText },
    });
    beacon.start(win);
    expect(sent(win)).toEqual([{ slug: 'pr-split', kind: 'visit', referrer: 'https://news.ycombinator.com/' }]);
    expect(button.hidden).toBe(false);

    await button.listeners.click();
    expect(writeText).toHaveBeenCalledWith(command.textContent);
    expect(button.textContent).toBe('Copied');
    command.listeners.copy();
    buy.listeners.click();
    expect(sent(win).map((s) => s.kind)).toEqual(['visit', 'activate', 'checkout']);
  });

  it('keeps the copy button hidden without a clipboard, and still counts a manual copy', () => {
    const command = element({ id: 'install' });
    const button = element({ dataset: { copy: 'install' } });
    const win = fakeWindow({ elements: { '[data-command]': [command], '[data-copy]': [button] } });
    beacon.start(win);
    expect(button.hidden).toBe(true);
    command.listeners.copy();
    expect(sent(win).map((s) => s.kind)).toEqual(['visit', 'activate']);
  });
});
