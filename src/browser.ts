import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { CONFIG, edgeArgs } from './config.js';
import { log } from './log.js';
import { SEL } from './selectors.js';

/**
 * Edge is spawned detached with a private profile and a CDP port, then attached
 * over CDP. The server never owns the Edge process: a server restart simply
 * reattaches, so music keeps playing across Claude Desktop restarts.
 *
 * Two tabs, each in its own off-screen window so both stay "visible" (the site
 * renders nothing in a hidden tab):
 *   - the PLAYER tab owns playback (transport, play_by_query, queue_add);
 *   - the BROWSE tab is for reading (search, playlists, open_url) so full page
 *     navigations never interrupt what is playing.
 */

let browser: Browser | null = null;
let page: Page | null = null;
let browsePage: Page | null = null;
let pending: Promise<Page> | null = null;
let pendingBrowse: Promise<Page> | null = null;
let creatingBrowse = false;
let loggedInConfirmed = false;
const wiredContexts = new WeakSet<BrowserContext>();

const endpoint = (): string => `http://127.0.0.1:${CONFIG.cdpPort}`;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint()}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export function isAttached(): boolean {
  return !!browser?.isConnected();
}

function spawnEdge(): void {
  if (!fs.existsSync(CONFIG.edgeExe)) {
    throw new Error(`Microsoft Edge not found at "${CONFIG.edgeExe}". Set AMZ_EDGE_EXE.`);
  }
  fs.mkdirSync(CONFIG.profileDir, { recursive: true });
  log.info('spawning Edge', { exe: CONFIG.edgeExe, profile: CONFIG.profileDir, port: CONFIG.cdpPort });
  const child = spawn(CONFIG.edgeExe, edgeArgs(), { detached: true, stdio: 'ignore' });
  child.on('error', (e) => log.error('Edge spawn failed', e));
  child.unref();
}

async function waitForCdp(ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cdpAlive()) return true;
    await sleep(250);
  }
  return false;
}

/** Runs scripts/taskbar.ps1 so the Edge windows have no taskbar button. Idempotent, ~1.5 s. */
export function setTaskbarHidden(hidden: boolean): Promise<string> {
  const script = path.join(CONFIG.scriptsDir, 'taskbar.ps1');
  if (!fs.existsSync(script) || !fs.existsSync(CONFIG.powershell)) return Promise.resolve('skipped');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProfileDir', CONFIG.profileDir];
  if (!hidden) args.push('-Restore');
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(CONFIG.powershell, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => log.warn('taskbar.ps1', String(d).trim()));
    const timer = setTimeout(() => {
      child.kill();
      resolve('timeout');
    }, 20_000);
    child.on('close', () => {
      clearTimeout(timer);
      const r = out.trim() || 'no-output';
      log.info('taskbar', r);
      resolve(r);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      log.warn('taskbar.ps1 failed', e);
      resolve('error');
    });
  });
}

async function attach(): Promise<Browser> {
  const b = await chromium.connectOverCDP(endpoint(), { timeout: 10_000 });
  b.on('disconnected', () => {
    if (browser === b) {
      log.warn('browser disconnected');
      browser = null;
      page = null;
      browsePage = null;
      loggedInConfirmed = false;
    }
  });
  return b;
}

/** Attach to a running Edge or spawn one. */
export async function ensureBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  let spawned = false;
  if (!(await cdpAlive())) {
    spawnEdge();
    spawned = true;
    if (!(await waitForCdp(25_000))) {
      throw new Error(`Edge started but port ${CONFIG.cdpPort} never answered; check the profile dir and AMZ_CDP_PORT.`);
    }
  }
  browser = await attach();
  log.info('attached to Edge', { version: browser.version() });
  if (spawned) void setTaskbarHidden(true);
  return browser;
}

function isMusicPage(p: Page): boolean {
  return !p.isClosed() && p.url().startsWith(CONFIG.origin);
}

async function ownsPlayer(p: Page): Promise<boolean> {
  return p
    .locator(SEL.transport.nowPlaying)
    .count()
    .then((n) => n > 0)
    .catch(() => false);
}

/** Keeps at most two tabs: the player tab and (optionally) one browse tab. */
async function adoptTabs(ctx: BrowserContext): Promise<Page> {
  const pages = ctx.pages().filter((x) => !x.isClosed());
  const music = pages.filter(isMusicPage);
  let player: Page | null = null;
  for (const x of music) {
    if (await ownsPlayer(x)) {
      player = x;
      break;
    }
  }
  player = player ?? music[0] ?? pages.find((x) => /^(about:blank|edge:\/\/newtab)/.test(x.url())) ?? pages[0] ?? null;
  if (!player) player = await ctx.newPage();
  const browse = music.find((x) => x !== player) ?? null;
  let closed = 0;
  for (const x of pages) {
    if (x !== player && x !== browse) {
      log.info('closing extra tab', { url: x.url().slice(0, 80) });
      await x.close().catch(() => {});
      closed++;
    }
  }
  browsePage = browse;
  if (closed > 0 || pages.length > 1) {
    // Only the active tab of a window renders; make sure ours are.
    await player.bringToFront().catch(() => {});
    await browse?.bringToFront().catch(() => {});
    await player.bringToFront().catch(() => {});
  }
  return player;
}

async function reconcileTabs(ctx: BrowserContext, np: Page): Promise<void> {
  if (np.isClosed() || !page || page.isClosed()) return;
  if (np === page || np === browsePage) return;
  if (!isMusicPage(np) && !/^about:blank/.test(np.url())) {
    log.info('closing non-music tab', { url: np.url().slice(0, 80) });
    await np.close().catch(() => {});
    return;
  }
  if (!browsePage || browsePage.isClosed()) {
    browsePage = np;
    np.setDefaultTimeout(CONFIG.waitMs);
    log.info('adopted browse tab');
    return;
  }
  log.info('closing extra tab (third tab)');
  await np.close().catch(() => {});
}

function wireContext(ctx: BrowserContext): void {
  if (wiredContexts.has(ctx)) return;
  wiredContexts.add(ctx);
  ctx.on('page', (np) => {
    if (creatingBrowse) return;
    // Another server instance (Claude Desktop + Claude Code both attach) may be creating its
    // browse tab; give it a moment, then keep at most player + one browse tab.
    setTimeout(() => void reconcileTabs(ctx, np), 1500);
  });
}

async function acquirePage(): Promise<Page> {
  const b = await ensureBrowser();
  const ctx = b.contexts()[0] ?? (await b.newContext());
  wireContext(ctx);
  const p = await adoptTabs(ctx);
  p.setDefaultTimeout(CONFIG.waitMs);
  browsePage?.setDefaultTimeout(CONFIG.waitMs);
  // Only navigate when the tab is parked on nothing; never yank a sign-in page away from the user.
  if (!/\bamazon\./.test(p.url())) {
    await p.goto(CONFIG.homeUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  }
  page = p;
  // Warm the browse tab in the background: creating it on demand costs the first search
  // ~10 s (new window + full page load), and it is needed by search/playlists/open_url.
  setTimeout(() => void ensureBrowsePage().catch((e) => log.warn('browse tab prewarm failed', e)), 1500);
  return p;
}

/** The player tab. Attaches/spawns Edge lazily. */
export async function ensurePage(): Promise<Page> {
  if (page && !page.isClosed() && browser?.isConnected()) return page;
  if (pending) return pending;
  pending = acquirePage().finally(() => {
    pending = null;
  });
  return pending;
}

async function createBrowsePage(a: Page): Promise<Page> {
  const ctx = a.context();
  const existing = ctx.pages().find((x) => x !== a && isMusicPage(x));
  if (existing) {
    await setWindowBounds(existing, { ...CONFIG.hiddenPos, ...CONFIG.window }).catch(() => {});
    return existing;
  }
  creatingBrowse = true;
  try {
    const b = await ensureBrowser();
    const s = await b.newBrowserCDPSession();
    try {
      // A separate window keeps this tab "visible" alongside the player tab.
      await s.send('Target.createTarget', {
        url: CONFIG.homeUrl,
        newWindow: true,
        background: true,
        left: CONFIG.hiddenPos.left,
        top: CONFIG.hiddenPos.top,
        width: CONFIG.window.width,
        height: CONFIG.window.height,
      });
    } finally {
      await s.detach().catch(() => {});
    }
    const t0 = Date.now();
    let np: Page | undefined;
    while (!np && Date.now() - t0 < 10_000) {
      np = ctx.pages().find((x) => x !== a && !x.isClosed() && /amazon\.|about:blank/.test(x.url()));
      if (!np) await sleep(100);
    }
    if (!np) throw new Error('The browse tab did not appear.');
    np.setDefaultTimeout(CONFIG.waitMs);
    await np.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await setWindowBounds(np, { ...CONFIG.hiddenPos, ...CONFIG.window }).catch(() => {});
    await a.bringToFront().catch(() => {});
    void setTaskbarHidden(true);
    log.info('browse tab created');
    return np;
  } finally {
    creatingBrowse = false;
  }
}

/** The browse tab (read-only navigation that must not interrupt playback). */
export async function ensureBrowsePage(): Promise<Page> {
  const a = await ensurePage();
  if (browsePage && !browsePage.isClosed()) return browsePage;
  if (pendingBrowse) return pendingBrowse;
  pendingBrowse = createBrowsePage(a)
    .then((p) => {
      browsePage = p;
      return p;
    })
    .finally(() => {
      pendingBrowse = null;
    });
  return pendingBrowse;
}

/**
 * Only one track may ever be audible. The browse tab shares the session and can start its
 * own playback (a stray click, an autoplaying preview), which would overlap the player tab,
 * so silence any media element there before the player tab starts something.
 */
export async function silenceOtherTabs(): Promise<number> {
  if (!browsePage || browsePage.isClosed()) return 0;
  try {
    return await browsePage.evaluate(() => {
      let stopped = 0;
      const walk = (root: ParentNode) => {
        for (const m of root.querySelectorAll('audio, video')) {
          const el = m as HTMLMediaElement;
          if (!el.paused) {
            el.pause();
            stopped++;
          }
          el.muted = true;
        }
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
      return stopped;
    });
  } catch {
    return 0;
  }
}

export function tabCount(): number {
  return [page, browsePage].filter((x) => x && !x.isClosed()).length;
}

async function withCdp<T>(p: Page, fn: (s: CDPSession) => Promise<T>): Promise<T> {
  const s = await p.context().newCDPSession(p);
  try {
    return await fn(s);
  } finally {
    await s.detach().catch(() => {});
  }
}

type Bounds = { left?: number; top?: number; width?: number; height?: number };

async function setWindowBounds(p: Page, bounds: Bounds): Promise<void> {
  await withCdp(p, async (s) => {
    const { windowId } = (await s.send('Browser.getWindowForTarget')) as { windowId: number };
    // A minimized window makes the tab "hidden" and the site stops rendering; always normalize first.
    await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await s.send('Browser.setWindowBounds', { windowId, bounds });
  });
}

export async function getWindowBounds(p: Page): Promise<Record<string, unknown> | null> {
  try {
    return await withCdp(p, async (s) => {
      const { windowId } = (await s.send('Browser.getWindowForTarget')) as { windowId: number };
      const { bounds } = (await s.send('Browser.getWindowBounds', { windowId })) as { bounds: Record<string, unknown> };
      return bounds;
    });
  } catch {
    return null;
  }
}

export async function showWindow(p: Page): Promise<void> {
  await setTaskbarHidden(false);
  await setWindowBounds(p, { ...CONFIG.shownPos, ...CONFIG.window });
  await p.bringToFront();
}

export async function hideWindow(p: Page): Promise<void> {
  await setWindowBounds(p, { ...CONFIG.hiddenPos, ...CONFIG.window });
  if (browsePage && !browsePage.isClosed()) await setWindowBounds(browsePage, { ...CONFIG.hiddenPos, ...CONFIG.window }).catch(() => {});
  await setTaskbarHidden(true);
}

export async function visibility(p: Page): Promise<string> {
  try {
    return await p.evaluate(() => document.visibilityState);
  } catch {
    return 'unknown';
  }
}

/** Re-normalize the window if the page reports itself hidden (e.g. the user minimized it). */
export async function ensureRendered(p: Page): Promise<void> {
  if ((await visibility(p)) === 'visible') return;
  log.warn('page hidden; activating tab and re-normalizing window');
  await p.bringToFront().catch(() => {});
  if ((await visibility(p)) === 'visible') return;
  await setWindowBounds(p, { ...CONFIG.hiddenPos, ...CONFIG.window }).catch((e) => log.warn('setWindowBounds failed', e));
  await sleep(300);
}

/**
 * true = logged in, false = sign-in button present, null = app shell not ready.
 * Amazon's auth cookie is the fast signal; the DOM is only consulted to confirm.
 */
export async function isLoggedIn(p: Page): Promise<boolean | null> {
  if (!/\bamazon\./.test(p.url())) return null;
  if (!p.url().startsWith(CONFIG.origin)) return false; // parked on www.amazon.com/ap/signin
  const signIn = p.locator(SEL.signInButton).first();
  if (loggedInConfirmed) {
    if ((await signIn.count()) === 0) return true;
    loggedInConfirmed = false;
    return false;
  }
  const cookies = await p.context().cookies(CONFIG.origin).catch(() => []);
  const hasAuth = cookies.some((c) => /^(at-main|sess-at-main|at-main-music)$/.test(c.name));
  if (!hasAuth) return false;
  if ((await signIn.count()) === 0) {
    loggedInConfirmed = true;
    return true;
  }
  const ready = p.locator(SEL.appReady).first();
  const ok = await ready
    .waitFor({ state: 'attached', timeout: CONFIG.waitMs })
    .then(() => true)
    .catch(() => false);
  if (!ok) return null;
  const appeared = await signIn
    .waitFor({ state: 'attached', timeout: 2500 })
    .then(() => true)
    .catch(() => false);
  if (appeared) return false;
  loggedInConfirmed = true;
  return true;
}

/** Closes Edge entirely (not just our connection). */
export async function quitBrowser(): Promise<boolean> {
  if (!(await cdpAlive())) {
    browser = null;
    page = null;
    browsePage = null;
    return false;
  }
  const b = await ensureBrowser();
  const s = await b.newBrowserCDPSession();
  await s.send('Browser.close').catch(() => {});
  browser = null;
  page = null;
  browsePage = null;
  return true;
}

/** Drop our CDP connection without touching Edge. */
export async function detach(): Promise<void> {
  const b = browser;
  browser = null;
  page = null;
  browsePage = null;
  await b?.close().catch(() => {});
}
