import type { Locator, Page } from 'playwright-core';
import { CONFIG } from './config.js';
import { ensureRendered, silenceOtherTabs, sleep } from './browser.js';
import { log } from './log.js';
import { SEL } from './selectors.js';
import { accentFor, type Rgb } from './accent.js';
import { parseTags, TAG_ATTRS, TAG_CHIP_SELECTOR, type Tag } from './tags.js';

export type PlaybackState = 'playing' | 'paused' | 'none';
/** off = play through once; all = repeat the playlist/album/queue; one = repeat the current song. */
export type RepeatMode = 'off' | 'all' | 'one';

export interface NowPlaying {
  title: string | null;
  artist: string | null;
  album: string | null;
  artwork: string | null;
  artistHref?: string | null;
  albumHref?: string | null;
  state: PlaybackState;
  position?: number;
  duration?: number;
  positionText?: string | null;
  shuffle?: boolean;
  repeat?: RepeatMode;
  liked?: boolean;
  volume?: number;
  tags: Tag[];
  explicit: boolean;
  /** Artist hero image the full Now Playing View uses as its backdrop (not the album cover). */
  background?: string | null;
  lyricsAvailable?: boolean;
  /** The line being sung right now, when lyrics are synced. */
  currentLyric?: string | null;
  lyrics?: { lines: string[]; activeIndex: number } | null;
  /** Signature colour of the album cover, [r,g,b], for tinting the widget. */
  accent?: Rgb | null;
  /** True when the artwork is black and white, so `accent` is a tone rather than a hue. */
  accentMono?: boolean;
  source: 'transport' | 'mediaSession' | 'none';
}

/** Everything the player bar exposes, read in ONE round trip. */
interface TransportRead {
  visibility: string;
  hasBar: boolean;
  title: string | null;
  artist: string | null;
  album: string | null;
  artwork: string | null;
  artistHref: string | null;
  albumHref: string | null;
  tagAttrs: (string | null)[];
  chips: (string | null)[];
  explicitAttr: boolean;
  npvOpen: boolean;
  background: string | null;
  lyricLines: string[];
  lyricActive: number;
  position?: number;
  duration?: number;
  positionText: string | null;
  labels: string[];
  msTitle: string | null;
  msArtist: string | null;
  msAlbum: string | null;
  msArtwork: string | null;
}

let lastVolume: number | null = null;

export function transport(p: Page): Locator {
  return p.locator(SEL.transport.root);
}

export async function transportButton(p: Page, name: RegExp): Promise<Locator | null> {
  const loc = transport(p).getByRole('button', { name });
  return (await loc.count()) > 0 ? loc.first() : null;
}

export async function readTransport(p: Page): Promise<TransportRead | null> {
  return p
    .evaluate(
      ([rootSel, npSel, progSel, tagAttrs, chipSel, lyricSel, bgSel, npvRootSel]) => {
        const g = (el: Element | null, a: string) => el?.getAttribute(a) ?? null;
        const root = document.querySelector(rootSel);
        const m = document.querySelector(npSel);
        const prog = document.querySelector(progSel);
        // Full Now Playing View: lyrics + artist backdrop (only present while it is open).
        const lyricEls = [...document.querySelectorAll(lyricSel)];
        const lyricLines = lyricEls.map((li) => (li.textContent ?? '').trim());
        let lyricActive = -1;
        lyricEls.forEach((li, i) => {
          if (lyricActive === -1 && /^rgb\(/.test(getComputedStyle(li).color)) lyricActive = i; // dimmed lines are rgba(...)
        });
        // The backdrop is a page-sized div; accept it by its 1920x1080 image name too, because
        // the element collapses to 0x0 the moment the view closes (the URL stays valid).
        let background: string | null = null;
        for (const el of document.querySelectorAll<HTMLElement>(bgSel)) {
          const mm = /url\("?([^")]+)"?\)/.exec(el.style.backgroundImage);
          if (!mm || !/media-amazon/.test(mm[1])) continue;
          if ((el.clientWidth > 600 && el.clientHeight > 300) || /_SX1920|_SY1080/.test(mm[1])) {
            background = mm[1];
            break;
          }
        }
        const labels: string[] = [];
        if (root) {
          const walk = (n: ParentNode) => {
            for (const el of n.querySelectorAll('button, [role="button"]')) {
              const l = el.getAttribute('aria-label') || el.textContent || '';
              if (l.trim()) labels.push(l.trim());
            }
            for (const el of n.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
          };
          walk(root);
        }
        // #npv is present only while the full view is open (the mini row's icon-name lags it).
        const npvOpen = !!document.querySelector(npvRootSel);
        const ms = navigator.mediaSession?.metadata;
        return {
          visibility: document.visibilityState,
          hasBar: !!m,
          title: g(m, 'primary-text'),
          artist: g(m, 'secondary-text'),
          album: g(m, 'secondary-text-2'),
          artwork: g(m, 'image-src'),
          artistHref: g(m, 'secondary-href'),
          albumHref: g(m, 'secondary-href-2'),
          tagAttrs: (tagAttrs as readonly string[]).map((a) => g(m, a)),
          chips: m ? [...m.querySelectorAll(chipSel)].map((c) => c.getAttribute('aria-label')) : [],
          explicitAttr: !!m && m.hasAttribute('is-explicit'),
          npvOpen,
          background,
          lyricLines,
          lyricActive,
          position: prog ? Number(g(prog, 'aria-valuenow')) : undefined,
          duration: prog ? Number(g(prog, 'aria-valuemax')) : undefined,
          positionText: g(prog, 'aria-valuetext'),
          labels,
          msTitle: ms?.title ?? null,
          msArtist: ms?.artist ?? null,
          msAlbum: ms?.album ?? null,
          msArtwork: ms?.artwork?.[0]?.src ?? null,
        };
      },
      [SEL.transport.root, SEL.transport.nowPlaying, SEL.transport.progress, TAG_ATTRS, TAG_CHIP_SELECTOR, SEL.npv.lyrics, SEL.npv.background, SEL.npv.root] as const,
    )
    .catch(() => null);
}

/** Opens or closes the full Now Playing View (lyrics + backdrop live there). */
export async function ensureNpv(p: Page, open: boolean): Promise<boolean> {
  const t = await readTransport(p);
  if (!t?.hasBar) return false;
  if (t.npvOpen === open) return true;
  const btn = open
    ? p.locator(SEL.transport.nowPlaying).getByRole('button', { name: SEL.transport.npvOpen })
    : p.locator(SEL.npv.closeButton);
  if ((await btn.count()) === 0) return false;
  await btn.first().click({ timeout: 3000, noWaitAfter: true, force: true });
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    await sleep(150);
    const r = await readTransport(p);
    if (r && r.npvOpen === open) {
      // Lyrics and the backdrop mount a beat after the view itself; wait for them briefly.
      // The backdrop JPEG can take a second to arrive; don't block on it — the cache picks
      // it up on the next read (the widget polls every few seconds).
      if (open) {
        const until = Date.now() + 900;
        while (Date.now() < until) {
          await sleep(120);
          const s = await readTransport(p);
          if (s?.background && s.lyricLines.length > 0) break;
        }
      }
      return true;
    }
  }
  return false;
}

const find = (labels: string[], re: RegExp): string | null => labels.find((l) => re.test(l)) ?? null;

/** Labels name the NEXT action: "Repeat All Songs" means repeat is currently off. */
function repeatFromLabel(label: string | null): RepeatMode | undefined {
  if (!label) return undefined;
  if (/off/i.test(label)) return 'one';
  if (/one/i.test(label)) return 'all';
  if (/all/i.test(label)) return 'off';
  return undefined;
}

function shuffleFromLabel(label: string | null): boolean | undefined {
  if (!label) return undefined;
  if (/turn off/i.test(label)) return true;
  if (/turn on/i.test(label)) return false;
  return undefined;
}

function likedFromLabel(label: string | null): boolean | undefined {
  if (!label) return undefined;
  return /unlike|remove/i.test(label);
}

export function stateFromLabels(labels: string[]): PlaybackState {
  const l = find(labels, SEL.transport.playPause);
  return l ? (/pause/i.test(l) ? 'playing' : 'paused') : 'none';
}

const EMPTY: NowPlaying = { title: null, artist: null, album: null, artwork: null, state: 'none', tags: [], explicit: false, source: 'none' };

export function toNowPlaying(t: TransportRead | null): NowPlaying {
  if (!t) return EMPTY;
  const state = stateFromLabels(t.labels);
  const title = t.title ?? t.msTitle;
  const tags = parseTags({ tagAttrs: t.tagAttrs, chips: t.chips, title, explicitAttr: t.explicitAttr });
  const hasLyrics = t.lyricLines.length > 0;
  return {
    title,
    artist: t.artist ?? t.msArtist,
    album: t.album ?? t.msAlbum,
    artwork: t.artwork ?? t.msArtwork,
    artistHref: t.artistHref,
    albumHref: t.albumHref,
    state,
    position: t.position,
    duration: t.duration,
    positionText: t.positionText,
    shuffle: shuffleFromLabel(find(t.labels, SEL.transport.shuffle)),
    repeat: repeatFromLabel(find(t.labels, SEL.transport.repeat)),
    liked: likedFromLabel(find(t.labels, SEL.transport.like)),
    volume: lastVolume ?? undefined,
    tags,
    explicit: tags.includes('explicit'),
    background: t.background,
    lyricsAvailable: tags.includes('lyrics') || hasLyrics,
    currentLyric: hasLyrics && t.lyricActive >= 0 ? t.lyricLines[t.lyricActive] : null,
    lyrics: hasLyrics ? { lines: t.lyricLines, activeIndex: t.lyricActive } : null,
    source: t.hasBar ? 'transport' : t.msTitle ? 'mediaSession' : 'none',
  };
}

/**
 * The backdrop and lyrics live in the Now Playing View and vanish from the DOM when it is
 * closed — and it must be closed for row-based tools (search, play, queue) to work. Cache
 * them per track so the view is opened at most once per song instead of on every poll.
 */
const npvCache = new Map<string, { background: string | null; lines: string[] }>();
const trackKey = (np: NowPlaying): string => `${np.title ?? ''}|${np.artist ?? ''}`;

function mergeNpvCache(np: NowPlaying): NowPlaying {
  if (!np.title) return np;
  const key = trackKey(np);
  const hit = npvCache.get(key);
  const liveLines = np.lyrics?.lines ?? [];
  // Merge, never overwrite with less: the backdrop and the lyric list appear at
  // different moments, so a read can legitimately see one but not the other.
  if (liveLines.length > 0 || np.background) {
    npvCache.set(key, { background: np.background ?? hit?.background ?? null, lines: liveLines.length > 0 ? liveLines : (hit?.lines ?? []) });
    if (npvCache.size > 20) npvCache.delete(npvCache.keys().next().value as string);
  }
  const merged = npvCache.get(key);
  if (!merged) return np;
  return {
    ...np,
    background: np.background ?? merged.background,
    lyricsAvailable: np.lyricsAvailable || merged.lines.length > 0,
    // activeIndex -1: the synced highlight only exists while the view is open.
    lyrics: liveLines.length > 0 ? np.lyrics! : merged.lines.length > 0 ? { lines: merged.lines, activeIndex: -1 } : np.lyrics ?? null,
  };
}

/** True when this track's Now Playing View has already been harvested (backdrop + lyrics). */
function npvCached(np: NowPlaying): boolean {
  if (!np.title) return false;
  const hit = npvCache.get(trackKey(np));
  return !!hit && !!hit.background;
}

/**
 * Current track. With `withNpv`, the full Now Playing View is opened (once; it stays open)
 * so the artist backdrop and synced lyrics are included.
 */
export async function nowPlaying(p: Page, withNpv = false): Promise<NowPlaying> {
  let t = await readTransport(p);
  if (withNpv && t?.hasBar && !t.npvOpen && !npvCached(toNowPlaying(t))) {
    if (await ensureNpv(p, true)) {
      t = await readTransport(p);
      const harvested = mergeNpvCache(toNowPlaying(t));
      // Close it again: while it is open it overlays the navbar and the player bar, so
      // searches fall back to a full page load and transport clicks land on the overlay.
      await ensureNpv(p, false);
      return withAccent(p, harvested);
    }
  }
  return withAccent(p, mergeNpvCache(toNowPlaying(t)));
}

/** Adds the cover's signature colour (cached per image URL, so ~0 ms after the first read). */
async function withAccent(p: Page, np: NowPlaying): Promise<NowPlaying> {
  if (!np.artwork && !np.background) return np;
  const a = await accentFor(p, np.artwork, np.background);
  return { ...np, accent: a?.rgb ?? null, accentMono: a?.mono ?? undefined };
}

/**
 * Timestamp of the last click-driven interaction. Opening the Now Playing View in the
 * background must not land on top of a search or a transport click, so the harvest holds
 * off for a moment after anything else has touched the page.
 */
let lastInteraction = 0;
export function noteInteraction(): void {
  lastInteraction = Date.now();
}

const harvesting = new Set<string>();

async function harvestNpv(p: Page, np: NowPlaying): Promise<void> {
  const key = trackKey(np);
  if (harvesting.size > 0 || Date.now() - lastInteraction < 2000) return;
  harvesting.add(key);
  try {
    if (await ensureNpv(p, true)) {
      mergeNpvCache(toNowPlaying(await readTransport(p)));
      await ensureNpv(p, false);
    }
  } catch (e) {
    log.warn('background Now Playing View harvest failed', e);
  } finally {
    harvesting.delete(key);
  }
}

/**
 * Current track without ever waiting on the Now Playing View. The backdrop and lyrics come
 * from the cache; when they are missing the view is harvested in the background, so a poll
 * costs one round trip (~10 ms) instead of the ~600-1000 ms the view takes to open, read
 * and close. The widget polls, so it picks the extras up a beat later either way.
 */
export async function nowPlayingLive(p: Page): Promise<NowPlaying> {
  const t = await readTransport(p);
  const np = mergeNpvCache(toNowPlaying(t));
  if (t?.hasBar && !t.npvOpen && np.title && !npvCached(np)) void harvestNpv(p, np);
  return withAccent(p, np);
}

/** Like nowPlaying, but always opens the view so the synced lyric highlight is live. */
export async function nowPlayingSynced(p: Page): Promise<NowPlaying> {
  let t = await readTransport(p);
  if (t?.hasBar && !t.npvOpen && (await ensureNpv(p, true))) t = await readTransport(p);
  return withAccent(p, mergeNpvCache(toNowPlaying(t)));
}

export async function waitForState(p: Page, want: PlaybackState, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = await readTransport(p);
    if (t && stateFromLabels(t.labels) === want) return true;
    await sleep(120);
  }
  return false;
}

export interface TrackWait extends NowPlaying {
  /** False when the timeout expired and the bar still shows what it showed before. */
  changed: boolean;
}

/** What the player bar held before the click, so "has it changed?" can be answered honestly. */
export type TrackBefore = Pick<NowPlaying, 'title' | 'position' | 'state'> | null;

/**
 * Has the bar moved on from `before`? A different title is the easy case. The same title
 * only counts when the track visibly *restarted* — it began rolling from a stop, or its
 * clock jumped backwards. Both of the looser rules this replaced ("position < 4", with or
 * without "playing") matched the track that was already there: a song paused at 0:00, or
 * one that had only just started, so every play reported, and then acted on, the wrong one.
 */
function isNewTrack(now: NowPlaying, before: TrackBefore): boolean {
  if (!now.title) return false;
  if (!before?.title || now.title !== before.title) return true;
  if (before.state !== 'playing') return now.state === 'playing';
  return now.state === 'playing' && (now.position ?? 1e9) <= (before.position ?? 0) - 2;
}

export async function waitForTrack(p: Page, before: TrackBefore, ms: number): Promise<TrackWait> {
  const t0 = Date.now();
  let last: NowPlaying = EMPTY;
  let loadedAt = 0;
  while (Date.now() - t0 < ms) {
    last = toNowPlaying(await readTransport(p));
    if (isNewTrack(last, before)) {
      // The bar names the new track a beat before audio flows. Return the moment it plays,
      // but don't hold the whole call hostage to Amazon's buffering: once the bar has
      // settled on the right song the answer is known, and `state` reports the truth.
      if (!loadedAt) loadedAt = Date.now();
      const rolling = last.state === 'playing';
      if (rolling || Date.now() - loadedAt > 450) {
        log.info(rolling ? 'waitForTrack' : 'waitForTrack (not yet rolling)', { title: last.title, barMs: loadedAt - t0, totalMs: Date.now() - t0 });
        // Hand back the enriched track, not the bare bar read: the caller's answer is what
        // the widget paints first, and without this it opens uncoloured and backdrop-less
        // until the next poll three seconds later.
        return { ...(await nowPlayingLive(p)), changed: true };
      }
    }
    await sleep(60);
  }
  return { ...last, changed: false };
}

/**
 * Clicks Pause straight from the page, with no state round-trips. The single-track stop
 * pays for every millisecond in audible music, so it cannot go through setPlayback's
 * read-click-verify cycle.
 */
export async function pauseNow(p: Page): Promise<boolean> {
  return p
    .evaluate((rootSel) => {
      const root = document.querySelector(rootSel);
      if (!root) return false;
      const walk = (n: ParentNode): HTMLElement | null => {
        for (const e of n.querySelectorAll('button, [role="button"]')) {
          if (/^pause$/i.test((e.getAttribute('aria-label') ?? '').trim())) return e as HTMLElement;
        }
        for (const e of n.querySelectorAll('*')) {
          if (e.shadowRoot) {
            const r = walk(e.shadowRoot);
            if (r) return r;
          }
        }
        return null;
      };
      const btn = walk(root);
      btn?.click();
      return !!btn;
    }, SEL.transport.root)
    .catch(() => false);
}

const CLICK = { timeout: CONFIG.waitMs, noWaitAfter: true } as const;

/**
 * The full Now Playing View overlays the player bar, so its buttons cannot be clicked
 * through it. Every transport action closes it first; this is a no-op when it is shut.
 */
async function readyForTransport(p: Page): Promise<void> {
  noteInteraction();
  await ensureRendered(p);
  await ensureNpv(p, false);
  void silenceOtherTabs(); // never two tracks at once
}

export async function setPlayback(p: Page, want: 'play' | 'pause' | 'toggle'): Promise<NowPlaying> {
  await readyForTransport(p);
  const before = await nowPlaying(p);
  if (before.state === 'none') {
    throw new Error('Nothing is loaded in the player yet. Use play_by_query or play_playlist first.');
  }
  const playing = before.state === 'playing';
  if (want === 'play' && playing) return before;
  if (want === 'pause' && !playing) return before;
  const target: PlaybackState = want === 'toggle' ? (playing ? 'paused' : 'playing') : want === 'play' ? 'playing' : 'paused';
  const btn = await transportButton(p, SEL.transport.playPause);
  if (!btn) throw new Error('Play/pause control not found on the player bar.');
  await btn.click(CLICK);
  await waitForState(p, target, 3000);
  return nowPlaying(p);
}

export async function skip(p: Page, dir: 'next' | 'previous'): Promise<NowPlaying> {
  await readyForTransport(p);
  const before = await nowPlaying(p);
  const btn = await transportButton(p, dir === 'next' ? SEL.transport.next : SEL.transport.previous);
  if (!btn) throw new Error(`No "${dir}" control found. Is something playing?`);
  await btn.click(CLICK);
  return waitForTrack(p, before, 4000);
}

export async function setVolume(p: Page, level: number): Promise<NowPlaying> {
  const v = Math.max(0, Math.min(100, Math.round(level)));
  await readyForTransport(p);
  const volBtn = await transportButton(p, SEL.transport.volume);
  if (!volBtn) throw new Error('Volume control not found. Is something playing?');
  const range = p.locator(SEL.transport.volumeRange);
  if ((await range.count()) === 0) {
    await volBtn.click(CLICK);
    await range.waitFor({ state: 'attached', timeout: 3000 });
  }
  await range.first().evaluate((el, val) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const max = Number(input.max || 1);
    setter?.call(input, String((val / 100) * max));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
  await sleep(150);
  await p.keyboard.press('Escape').catch(() => {});
  if ((await range.count()) > 0) await volBtn.click({ timeout: 2000, noWaitAfter: true }).catch(() => {});
  lastVolume = v;
  return nowPlaying(p);
}

export async function setShuffle(p: Page, want?: 'on' | 'off'): Promise<NowPlaying> {
  await readyForTransport(p);
  const btn = await transportButton(p, SEL.transport.shuffle);
  if (!btn) throw new Error('Shuffle control not found. Is something playing?');
  const cur = shuffleFromLabel(await btn.getAttribute('aria-label'));
  const wantOn = want === undefined ? !cur : want === 'on';
  if (cur !== wantOn) {
    await btn.click(CLICK);
    await sleep(300);
  }
  return nowPlaying(p);
}

/** Cycles Amazon's repeat button (off → all → one → off) until it shows `mode`. */
export async function setRepeat(p: Page, mode: RepeatMode): Promise<NowPlaying> {
  await readyForTransport(p);
  const btn = await transportButton(p, SEL.transport.repeat);
  if (!btn) throw new Error('Repeat control not found. Is something playing?');
  for (let i = 0; i < 3; i++) {
    const cur = repeatFromLabel(await btn.getAttribute('aria-label'));
    if (cur === mode) break;
    await btn.click(CLICK);
    await sleep(350);
  }
  const np = await nowPlaying(p);
  if (np.repeat !== mode) log.warn('repeat mode not reached', { wanted: mode, got: np.repeat });
  return np;
}

export async function like(p: Page, want: boolean): Promise<NowPlaying> {
  await readyForTransport(p);
  const btn = await transportButton(p, SEL.transport.like);
  if (!btn) throw new Error('Like control not found. Is something playing?');
  const cur = likedFromLabel(await btn.getAttribute('aria-label'));
  if (cur !== want) {
    await btn.click(CLICK);
    await sleep(400);
  }
  return nowPlaying(p);
}

export interface QueueItem {
  title: string | null;
  artist: string | null;
  album: string | null;
  href: string | null;
  artwork: string | null;
  tags: Tag[];
  explicit: boolean;
}

/**
 * Last known Autoplay state. Reading it opens a settings dialog (~700 ms) and it changes
 * only when someone changes it, so callers that just need to know can use this.
 */
let autoplayCache: boolean | null = null;
export const knownAutoplay = (): boolean | null => autoplayCache;

/** Reads the Autoplay setting through the gear menu's dialog; sets it when `enabled` is given. */
export async function autoplay(p: Page, enabled?: boolean): Promise<{ enabled: boolean; changed: boolean }> {
  await ensureRendered(p);
  await p.keyboard.press('Escape').catch(() => {});
  const gear = p.getByRole('button', { name: SEL.settings.gear }).first();
  await gear.click({ timeout: CONFIG.waitMs, force: true, noWaitAfter: true });
  const item = p.locator(SEL.settings.autoplayItem).first();
  await item.waitFor({ state: 'attached', timeout: 4000 });
  // The menu slides in, so the row is "not stable" for a beat and a normal click retries
  // itself into a timeout. Let it land, then click through the animation.
  await sleep(250);
  await item.click({ timeout: 3000, force: true, noWaitAfter: true });
  const dialog = p.locator(SEL.menu.dialog).first();
  await dialog.waitFor({ state: 'visible', timeout: CONFIG.waitMs });
  await sleep(300);
  // The dialog offers the opposite action: "Enable" when autoplay is off, "Disable" when on.
  const enable = dialog.getByRole('button', { name: /^enable$/i });
  const disable = dialog.getByRole('button', { name: /^disable$|^turn off$/i });
  const current = (await disable.count()) > 0 ? true : (await enable.count()) > 0 ? false : null;
  if (current === null) {
    await p.keyboard.press('Escape').catch(() => {});
    throw new Error('Autoplay dialog opened but its state could not be read (see debug_snapshot).');
  }
  if (enabled === undefined || enabled === current) {
    await dialog.getByRole('button', { name: /^dismiss$|^cancel$|^close$/i }).first().click({ timeout: 2000, noWaitAfter: true }).catch(() => p.keyboard.press('Escape'));
    autoplayCache = current;
    return { enabled: current, changed: false };
  }
  await (enabled ? enable : disable).first().click({ timeout: 3000, noWaitAfter: true });
  await sleep(500);
  if (await dialog.isVisible().catch(() => false)) await p.keyboard.press('Escape').catch(() => {});
  autoplayCache = enabled;
  return { enabled, changed: true };
}

export async function queue(p: Page): Promise<{ items: QueueItem[] }> {
  await readyForTransport(p);
  const toggle = await transportButton(p, SEL.transport.queueToggle);
  if (!toggle) throw new Error('Queue control not found. Is something playing?');
  const opened = /open/i.test((await toggle.getAttribute('aria-label')) ?? '');
  if (opened) {
    await toggle.click(CLICK);
    await p.locator(SEL.queue.row).first().waitFor({ state: 'attached', timeout: CONFIG.waitMs }).catch(() => {});
    await sleep(300);
  }
  const raw = await p.locator(SEL.queue.row).evaluateAll(
    (els, tagAttrs) =>
      els.map((e) => ({
        title: e.getAttribute('primary-text'),
        artist: e.getAttribute('secondary-text-1'),
        album: e.getAttribute('secondary-text-2'),
        href: e.getAttribute('primary-href'),
        artwork: e.getAttribute('image-src'),
        tagAttrs: (tagAttrs as readonly string[]).map((a) => e.getAttribute(a)),
        explicitAttr: e.hasAttribute('is-explicit'),
      })),
    TAG_ATTRS,
  );
  // The overlay renders the virtualized list twice; keep the first copy of each row.
  const seen = new Set<string>();
  const items: QueueItem[] = [];
  for (const r of raw) {
    const k = `${r.href}|${r.title}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const tags = parseTags({ tagAttrs: r.tagAttrs, title: r.title, explicitAttr: r.explicitAttr });
    items.push({ title: r.title, artist: r.artist, album: r.album, href: r.href, artwork: r.artwork, tags, explicit: tags.includes('explicit') });
  }
  if (opened) {
    const close = await transportButton(p, SEL.transport.queueToggle);
    await close?.click({ timeout: 2000, noWaitAfter: true }).catch((e) => log.warn('closing queue failed', e));
  }
  return { items };
}
