// npm run build: writes the website to dist/, which Vercel serves (vercel.json).
//   node site/build.mjs [--out <dir>]
// Reads STRIPE_PAYMENT_LINK, VERCEL_ENV, SITE_URL and VERCEL_PROJECT_PRODUCTION_URL (see
// site/pages.mjs). They are baked into static files, so a changed value needs a new deployment.
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { drawShareImage } from './og-image.mjs';
import { PAGES, SHARE_IMAGE, renderSite, siteConfig } from './pages.mjs';

export const DEFAULT_OUT = fileURLToPath(new URL('../dist', import.meta.url));
const STATIC = fileURLToPath(new URL('public', import.meta.url));

/** Writes every file of the site into `outDir` and returns the settings it used. */
export function buildSite({ env = process.env, outDir = DEFAULT_OUT, log = () => {} } = {}) {
  const config = siteConfig(env);
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(STATIC)) copyFileSync(join(STATIC, name), join(outDir, name));
  for (const [name, content] of Object.entries(renderSite(config))) writeFileSync(join(outDir, name), content);
  writeFileSync(join(outDir, SHARE_IMAGE.path.slice(1)), drawShareImage());

  if (config.paymentLinkInvalid) log("site: STRIPE_PAYMENT_LINK isn't an https URL, so the Buy button is hidden");
  log(
    `site: ${PAGES.length} pages for ${config.siteUrl} in ${outDir}; ` +
      `Buy button ${config.paymentLink ? 'shown' : 'hidden (STRIPE_PAYMENT_LINK unset)'}; ` +
      `beacon ${config.vercelEnv === 'production' ? 'on' : `off (VERCEL_ENV is ${config.vercelEnv})`}`,
  );
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  buildSite({ outDir: values.out ? resolve(values.out) : DEFAULT_OUT, log: (line) => console.log(line) });
}
