import type { Page } from 'playwright-core';
import { CONFIG } from './config.js';
import { ensureRendered, sleep } from './browser.js';
import { log } from './log.js';
import { SEL } from './selectors.js';
import { ensureNpv, noteInteraction, nowPlayingLive, readTransport, setPlayback, toNowPlaying, waitForTrack, type TrackWait } from './player.js';
import type { PlayIntent } from './singleTrack.js';
import { parseTags, TAG_ATTRS, TAG_CHIP_SELECTOR, type Tag } from './tags.js';

export type ResultType = 'song' | 'album' | 'artist' | 'playlist' | 'station' | 'podcast' | 'unknown';
export type SearchType = ResultType | 'all';

export interface SearchResult {
  type: ResultType;
  title: string | null;
  subtitle: string | null;
  href: string | null;
  artwork: string | null;
  section: string | null;
  tags: Tag[];
  explicit: boolean;
}

/** Results seen recently, by href, so a later play_href can re-find a row by searching its title. */
const resultCache = new Map<string, SearchResult>();

export function typeFromHref(href: string | null, section: string | null): ResultType {
  const h = href ?? '';
  if (/^\/artists\//.test(h)) return 'artist';
  if (/^\/albums\/[^/?]+\?.*trackAsin=/.test(h)) return 'song';
  if (/^\/albums\//.test(h)) return 'album';
  if (/^\/(user-|my\/)?playlists\//.test(h)) return 'playlist';
  if (/^\/stations\//.test(h)) return 'station';
  if (/^\/podcasts\//.test(h)) return 'podcast';
  const s = (section ?? '').toLowerCase();
  if (s.startsWith('song')) return 'song';
  if (s.startsWith('album')) return 'album';
  if (s.startsWith('artist')) return 'artist';
  if (s.startsWith('playlist')) return 'playlist';
  if (s.startsWith('station')) return 'station';
  if (s.startsWith('podcast')) return 'podcast';
  return 'unknown';
}

export function absoluteUrl(href: string): string {
  return href.startsWith('http') ? href : `${CONFIG.origin}${href.startsWith('/') ? '' : '/'}${href}`;
}

/** Waits until the number of matching elements stops growing (sections hydrate one by one). */
export async function settle(p: Page, selector: string, maxMs: number, quietMs = 150): Promise<void> {
  const t0 = Date.now();
  let last = -1;
  let stable = 0;
  while (Date.now() - t0 < maxMs) {
    const n = await p.locator(selector).count();
    stable = n === last ? stable + 1 : 0;
    if (stable >= 2) return;
    last = n;
    await sleep(quietMs);
  }
}

/** Reads the light-DOM attributes of every result-like item currently on the page. */
export async function parseItems(p: Page, selector: string = SEL.item): Promise<SearchResult[]> {
  const raw = await p.locator(selector).evaluateAll(
    (els, [tagAttrs, chipSel]) =>
      els.map((e) => ({
        title: e.getAttribute('primary-text'),
        subtitle: e.getAttribute('secondary-text'),
        href: e.getAttribute('primary-href'),
        artwork: e.getAttribute('image-src'),
        section: e.closest('music-shoveler')?.getAttribute('primary-text') ?? null,
        label: e.getAttribute('label'),
        tagAttrs: (tagAttrs as readonly string[]).map((a) => e.getAttribute(a)),
        chips: [...e.querySelectorAll(chipSel as string)].map((c) => c.getAttribute('aria-label')),
        badge: e.getAttribute('tertiary-badge-text'),
        explicitAttr: e.hasAttribute('is-explicit'),
      })),
    [TAG_ATTRS, TAG_CHIP_SELECTOR] as const,
  );
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of raw) {
    if (!r.title && !r.href) continue;
    if (r.href === '#') continue; // the player bar's mini now-playing row
    const key = r.href ?? `${r.title}|${r.subtitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = parseTags({ tagAttrs: r.tagAttrs, chips: r.chips, title: r.title, explicitAttr: r.explicitAttr, badge: r.badge });
    const type = typeFromHref(r.href, r.section ?? r.label);
    const item: SearchResult = { type, title: r.title, subtitle: r.subtitle, href: r.href, artwork: r.artwork, section: r.section, tags, explicit: tags.includes('explicit') };
    out.push(item);
    if (r.href) resultCache.set(r.href, item);
  }
  return out;
}

// ---- query understanding -----------------------------------------------------------------------

const TYPE_WORDS: [RegExp, ResultType][] = [
  [/\b(the )?album\b/i, 'album'],
  [/\bplaylist\b/i, 'playlist'],
  [/\b(radio|station)\b/i, 'station'],
  [/\bpodcast\b/i, 'podcast'],
  [/\b(song|track|single)\b/i, 'song'],
  [/\b(artist|band)\b/i, 'artist'],
];

export interface ParsedQuery {
  /** Query with type words / "play" stripped. */
  text: string;
  /** Title part when the query looked like "<title> by <artist>". */
  title: string | null;
  artist: string | null;
  inferredType: SearchType;
}

export function parseQuery(query: string, type: SearchType = 'all'): ParsedQuery {
  let q = query.trim().replace(/^(please\s+)?(play|put on|start|queue( up)?)\s+/i, '');
  let inferred: SearchType = type;
  if (inferred === 'all') {
    for (const [re, t] of TYPE_WORDS) {
      if (re.test(q)) {
        inferred = t;
        q = q.replace(re, ' ');
        break;
      }
    }
  }
  q = q.replace(/\b(some|something|music|songs?)\s*$/i, '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?)\s+(?:by|from|-|–|—)\s+(.+)$/i.exec(q);
  const title = m ? m[1].trim() : null;
  const artist = m ? m[2].trim() : null;
  if (m && inferred === 'all') inferred = 'song';
  return { text: q, title, artist, inferredType: inferred };
}

const norm = (s: string | null | undefined): string =>
  (s ?? '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function overlap(a: string, b: string): number {
  const ta = new Set(norm(a).split(' ').filter(Boolean));
  const tb = new Set(norm(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / ta.size;
}

/** With no type hint, catalog items beat user-made playlists and podcasts. */
const TYPE_PRIOR: Partial<Record<ResultType, number>> = { song: 0.35, artist: 0.3, album: 0.25, station: 0.05, playlist: 0, podcast: -0.5, unknown: -0.2 };

/** Scores how well a result answers the parsed query (0..~3). Higher is better. */
export function scoreResult(r: SearchResult, q: ParsedQuery): number {
  const title = norm(r.title);
  const sub = norm(r.subtitle);
  let s = 0;
  if (q.title && q.artist) {
    s += overlap(q.title, title) * 1.5;
    if (norm(q.title) === title) s += 0.6;
    s += overlap(q.artist, sub) * 1.2;
    if (r.type === 'song') s += 0.3;
  } else {
    const both = `${title} ${sub}`;
    s += overlap(q.text, both) * 1.5;
    if (norm(q.text) === title) s += 0.8;
    else if (title.startsWith(norm(q.text))) s += 0.3;
    // "<title> <artist>" without "by": every title word and most artist words appear in the query.
    if (title && sub && overlap(title, q.text) >= 0.99 && overlap(sub, q.text) >= 0.5) s += 1.0;
  }
  if (q.inferredType !== 'all') s += r.type === q.inferredType ? 0.5 : -0.6;
  else s += TYPE_PRIOR[r.type] ?? 0;
  if (r.section === 'Top Results') s += 0.15;
  return s;
}

export function pickResult(results: SearchResult[], q: ParsedQuery): SearchResult | null {
  const usable = results.filter((r) => r.href && r.href !== '#');
  if (usable.length === 0) return null;
  let best = usable[0];
  let bestScore = -Infinity;
  for (const r of usable) {
    const sc = scoreResult(r, q);
    if (sc > bestScore) {
      best = r;
      bestScore = sc;
    }
  }
  return best;
}

// ---- search -------------------------------------------------------------------------------------

/**
 * Runs a search in `p`. Typing into the site's search box is an in-app (SPA) navigation
 * that lands results in ~1.4 s and never interrupts playback; a full page load takes
 * ~4 s, so that is only the fallback.
 */
/** True when the player bar is already on the track this result names. */
function sameTrack(bar: { title: string | null; albumHref?: string | null }, r: SearchResult): boolean {
  if (!bar.title || !r.title) return false;
  // Symmetric, so "Get Lucky" does not swallow "Get Lucky (Live)" or the other way round.
  if (overlap(bar.title, r.title) < 0.8 || overlap(r.title, bar.title) < 0.8) return false;
  if (bar.albumHref && r.href && !r.href.startsWith(bar.albumHref)) return false;
  return true;
}

/** True when the page is already showing hydrated results for exactly this query. */
async function showingSearchFor(p: Page, text: string): Promise<boolean> {
  let path: string;
  try {
    path = new URL(p.url()).pathname;
  } catch {
    return false;
  }
  if (!path.startsWith('/search/')) return false;
  const shown = decodeURIComponent(path.slice('/search/'.length).replace(/\+/g, ' '));
  if (shown.trim().toLowerCase() !== text.trim().toLowerCase()) return false;
  return (await p.locator(SEL.itemReady).count()) > 0;
}

export async function gotoSearch(p: Page, text: string, mark: (k: string) => void = () => {}): Promise<void> {
  noteInteraction();
  await ensureRendered(p);
  await ensureNpv(p, false); // the Now Playing View covers the search box and result rows
  // Already looking at the results for this query. Re-running it is not just wasted work:
  // the URL never changes and the first row never changes, so both "did it navigate?" waits
  // below run to their full timeouts — 9 s of nothing.
  if (await showingSearchFor(p, text)) {
    mark('cached');
    return;
  }
  const box = p.locator(SEL.searchInput);
  if (p.url().startsWith(CONFIG.origin) && (await box.count()) > 0) {
    try {
      const before = await p.evaluate((sel) => {
        const e = document.querySelector(sel);
        return e ? `${e.getAttribute('primary-href')}|${e.getAttribute('primary-text')}` : null;
      }, SEL.itemReady);
      const oldUrl = p.url();
      mark('boxReady');
      // Safety net: anything overlaying the navbar (a stray Now Playing View) hides the box.
      if (!(await box.isVisible().catch(() => false))) await ensureNpv(p, false);
      // fill() focuses the box itself; a separate click is a wasted round trip.
      await box.fill(text, { timeout: 2000 });
      await box.press('Enter', { timeout: 2000 });
      mark('typed');
      await p.waitForURL((u) => u.pathname.startsWith('/search/') && u.href !== oldUrl, { timeout: 5000, waitUntil: 'commit' }).catch(() => {});
      mark('url');
      // Rows are re-rendered for the new query; wait until the first hydrated row is a different one.
      await p
        .waitForFunction(
          ([sel, prev]) => {
            const e = document.querySelector(sel as string);
            return !!e && `${e.getAttribute('primary-href')}|${e.getAttribute('primary-text')}` !== prev;
          },
          [SEL.itemReady, before] as const,
          { timeout: 4000, polling: 60 },
        )
        .catch(async () => {
          await sleep(500);
        });
      mark('rows');
      await p.locator(SEL.itemReady).first().waitFor({ state: 'attached', timeout: CONFIG.waitMs });
      return;
    } catch (e) {
      log.warn('search box path failed; falling back to navigation', e);
    }
  }
  await p.goto(`${CONFIG.origin}/search/${encodeURIComponent(text)}`, { waitUntil: 'commit', timeout: 20_000 });
  await p.locator(SEL.itemReady).first().waitFor({ state: 'attached', timeout: CONFIG.waitMs });
}

export async function search(p: Page, query: string, type: SearchType = 'all', limit = 10, quick = false): Promise<SearchResult[]> {
  const q = parseQuery(query, type);
  await gotoSearch(p, q.text || query);
  // Top Results hydrate first; the widget only needs those, the model may want every section.
  await settle(p, SEL.itemReady, quick ? 450 : 1500);
  const all = await parseItems(p);
  const want = type === 'all' ? q.inferredType : type;
  const filtered = want === 'all' ? all : all.filter((r) => r.type === want);
  const ranked = [...filtered].sort((a, b) => scoreResult(b, q) - scoreResult(a, q));
  return ranked.slice(0, Math.max(1, limit));
}

function cssString(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function itemByHref(href: string): string {
  return SEL.item
    .split(',')
    .map((s) => `${s.trim()}[primary-href="${cssString(href)}"]`)
    .join(', ');
}

/**
 * Makes a row for `href` present in the player tab without a full reload when possible:
 * already on screen → done; known from a recent search → SPA-search its title; otherwise
 * open the album/playlist page (a reload, acceptable because playback is about to change).
 */
async function locateRow(p: Page, href: string): Promise<boolean> {
  await ensureNpv(p, false);
  const row = p.locator(itemByHref(href)).first();
  if ((await row.count()) > 0) return true;
  const known = resultCache.get(href);
  if (known?.title) {
    await gotoSearch(p, [known.title, known.subtitle].filter(Boolean).join(' ')).catch(() => {});
    await settle(p, SEL.itemReady, 1200);
    if ((await row.count()) > 0) return true;
  }
  await p.goto(absoluteUrl(href.replace(/\?.*$/, '')), { waitUntil: 'commit', timeout: 20_000 });
  await p.locator(SEL.itemReady).first().waitFor({ state: 'attached', timeout: CONFIG.waitMs }).catch(() => {});
  await settle(p, SEL.item, 1200);
  return (await row.count()) > 0;
}

/** Clicks the inline Play control of a result row; falls back to the detail page's Play. */
export async function playHref(p: Page, href: string): Promise<void> {
  await ensureRendered(p);
  if (await locateRow(p, href)) {
    const row = p.locator(itemByHref(href)).first();
    try {
      await row.scrollIntoViewIfNeeded();
      await row.hover({ timeout: 2000 }).catch(() => {});
      await row.locator(SEL.itemPlayButton).first().click({ timeout: 3000, force: true, noWaitAfter: true });
      return;
    } catch (e) {
      log.warn('inline play failed; using detail page', e);
    }
  }
  if (!p.url().includes(href.replace(/\?.*$/, ''))) {
    await p.goto(absoluteUrl(href), { waitUntil: 'commit', timeout: 20_000 });
  }
  await p.locator(SEL.detailPlayButton).first().click({ timeout: CONFIG.waitMs, noWaitAfter: true });
}

export async function playByQuery(
  p: Page,
  query: string,
  type: SearchType = 'all',
): Promise<{ played: SearchResult; now_playing: TrackWait; candidates: SearchResult[]; intent: PlayIntent; watch: string | null } | null> {
  let intent: PlayIntent = 'collection';
  const q = parseQuery(query, type);
  const t0 = Date.now();
  const marks: Record<string, number> = {};
  const mark = (k: string) => (marks[k] = Date.now() - t0);
  // Only the title is needed, so read the bar directly rather than paying for artwork
  // colour extraction and the Now Playing View.
  const before = toNowPlaying(await readTransport(p));
  mark('before');
  await gotoSearch(p, q.text || query, mark);
  mark('search');
  // Top Results hydrate first; only wait for the rest when they are not enough.
  let results = await parseItems(p);
  let pick = pickResult(results, q);
  if (!pick || scoreResult(pick, q) < 1) {
    await settle(p, SEL.itemReady, 2000);
    results = await parseItems(p);
    pick = pickResult(results, q);
  }
  mark('pick');
  if (!pick?.href) return null;
  intent = pick.type === 'song' ? 'single' : 'collection';
  // Asking for the song that is already loaded. Clicking the row would *toggle* it off, and
  // waiting for a track change that can never come costs the full timeout — answer directly.
  // Only for songs: an album or playlist whose name happens to match the current track is a
  // real request to start that collection.
  if (pick.type === 'song' && sameTrack(before, pick)) {
    let np: TrackWait;
    if (before.state === 'playing') {
      np = { ...(await nowPlayingLive(p)), changed: true };
    } else {
      await setPlayback(p, 'play').catch(() => {});
      np = await waitForTrack(p, null, 2500);
    }
    mark('already');
    log.info('play_by_query timing', { ...marks, alreadyPlaying: true });
    return { played: pick, now_playing: np, candidates: results.slice(0, 5), intent, watch: np.title };
  }
  await playHref(p, pick.href);
  mark('click');
  let np = await waitForTrack(p, before, 7000);
  // Nothing changed because the requested song was already the one loaded. A result row's
  // inline control is a *toggle*, so the click will have paused it — put it back.
  if (!np.changed && sameTrack(np, pick)) {
    if (np.state === 'playing') np = { ...np, changed: true };
    else {
      await setPlayback(p, 'play').catch(() => {});
      np = await waitForTrack(p, null, 2500);
    }
  }
  mark('playing');
  log.info('play_by_query timing', { ...marks, changed: np.changed });
  // Never hand a stale title to the single-track stop: pausing the moment the player shows
  // "something other than X" is only safe when X really is what started.
  const watch = np.changed && np.title ? np.title : null;
  return { played: pick, now_playing: np, candidates: results.slice(0, 5), intent, watch };
}

// ---- queue ----------------------------------------------------------------------------------------

async function rowMenuAction(p: Page, href: string, action: RegExp): Promise<{ ok: boolean; menu: string[] }> {
  if (!(await locateRow(p, href))) return { ok: false, menu: [] };
  const row = p.locator(itemByHref(href)).first();
  await row.scrollIntoViewIfNeeded();
  await row.hover({ timeout: 2000 }).catch(() => {});
  const more = row.locator(SEL.itemMoreButton).first();
  if ((await more.count()) === 0) return { ok: false, menu: [] };
  await more.click({ timeout: 3000, force: true, noWaitAfter: true });
  await p.locator(SEL.menu.item).first().waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
  await sleep(150);
  const labels: string[] = await p.locator(SEL.menu.item).evaluateAll((els) => els.map((e) => e.getAttribute('primary-text') ?? e.textContent?.trim() ?? ''));
  const idx = labels.findIndex((l) => action.test(l));
  if (idx < 0) {
    await p.keyboard.press('Escape').catch(() => {});
    return { ok: false, menu: labels };
  }
  await p.locator(SEL.menu.item).nth(idx).click({ timeout: 3000, noWaitAfter: true });
  await sleep(300);
  return { ok: true, menu: labels };
}

/** Adds a search result (song/album/playlist) to the play queue, next or last. */
export async function queueAdd(
  p: Page,
  opts: { query?: string; href?: string; type?: SearchType; position: 'next' | 'last' },
): Promise<{ queued: SearchResult; position: 'next' | 'last'; ok: boolean; note?: string }> {
  let target: SearchResult | null = null;
  if (opts.href) {
    target = resultCache.get(opts.href) ?? { type: typeFromHref(opts.href, null), title: null, subtitle: null, href: opts.href, artwork: null, section: null, tags: [], explicit: false };
  } else if (opts.query) {
    const q = parseQuery(opts.query, opts.type ?? 'all');
    if (q.inferredType === 'all' || q.inferredType === 'artist') q.inferredType = 'song';
    await gotoSearch(p, q.text || opts.query);
    await settle(p, SEL.itemReady, 1200);
    const results = (await parseItems(p)).filter((r) => r.type === 'song' || r.type === 'album' || r.type === 'playlist');
    target = pickResult(results, q);
    if (!target) throw new Error(`Nothing queueable found for "${opts.query}".`);
  } else {
    throw new Error('Provide query or href.');
  }
  const action = opts.position === 'next' ? SEL.menu.playNext : SEL.menu.addToQueue;
  const r = await rowMenuAction(p, target.href!, action);
  return r.ok
    ? { queued: target, position: opts.position, ok: true }
    : { queued: target, position: opts.position, ok: false, note: `No "${opts.position === 'next' ? 'Play Next' : 'Add to Queue'}" entry for this item. Menu: ${r.menu.join(', ') || 'none'}` };
}
