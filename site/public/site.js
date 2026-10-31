// The site's only script. It wires the Copy button and tells RepoHQ about three events, as the
// privacy page says: "visit" (once per browser session), "activate" (the first copy of the install
// command, once per browser) and "checkout" (a click on Buy). Each is a fire-and-forget POST of
// {slug, kind, referrer}: no cookies, no identifier. Nothing is sent from preview or local builds,
// from automated browsers (navigator.webdriver), or when localStorage "repohq:notrack" is set.
export const SIGNAL_URL = 'https://idea-factory.1426davejobs.workers.dev/api/ideas/signal';
export const SLUG = 'pr-split';
export const NOTRACK_KEY = 'repohq:notrack';
/** Events sent at most once, and where that is remembered. "checkout" is sent on every click. */
export const ONCE = {
  visit: { storage: 'sessionStorage', key: `repohq:${SLUG}:visit` },
  activate: { storage: 'localStorage', key: `repohq:${SLUG}:activate` },
};
const COPIED_RESET_MS = 2000;

/** The referrer only when it is another site; this site's own URLs never leave the page. */
export function externalReferrer(referrer, origin) {
  if (!referrer) return null;
  try {
    return new URL(referrer).origin === origin ? null : referrer;
  } catch {
    return null;
  }
}

/** Production build (the build stamps VERCEL_ENV on <html>), a person, and no opt-out. */
export function trackingAllowed(win) {
  if (win.document.documentElement.dataset.vercelEnv !== 'production') return false;
  if (win.navigator.webdriver) return false;
  try {
    return win.localStorage.getItem(NOTRACK_KEY) === null;
  } catch {
    // Storage is blocked: the opt-out can't be read, so send nothing.
    return false;
  }
}

/** Sends one event unless it isn't allowed or was already sent. Returns whether it sent. */
export function signal(win, kind) {
  if (!trackingAllowed(win)) return false;
  const once = ONCE[kind];
  if (once) {
    try {
      const store = win[once.storage];
      if (store.getItem(once.key) !== null) return false;
      store.setItem(once.key, '1');
    } catch {
      return false;
    }
  }
  const body = JSON.stringify({ slug: SLUG, kind, referrer: externalReferrer(win.document.referrer, win.location.origin) });
  try {
    win
      .fetch(SIGNAL_URL, {
        method: 'POST',
        keepalive: true,
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body,
      })
      .catch(() => {});
  } catch {
    // Fire and forget: counting must never break the page.
  }
  return true;
}

export function start(win) {
  const doc = win.document;
  signal(win, 'visit');
  for (const link of doc.querySelectorAll('[data-buy]')) link.addEventListener('click', () => signal(win, 'checkout'));
  // Copying the command by hand counts too, not only the button.
  for (const block of doc.querySelectorAll('[data-command]')) block.addEventListener('copy', () => signal(win, 'activate'));
  if (!win.navigator.clipboard) return;
  for (const button of doc.querySelectorAll('[data-copy]')) {
    const source = doc.getElementById(button.dataset.copy);
    if (!source) continue;
    button.hidden = false;
    button.addEventListener('click', async () => {
      signal(win, 'activate');
      try {
        await win.navigator.clipboard.writeText(source.textContent);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Select and copy';
      }
      win.setTimeout(() => {
        button.textContent = 'Copy';
      }, COPIED_RESET_MS);
    });
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') start(window);
