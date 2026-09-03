// Embedded MCP App: talks to the amazon-music server through the host via postMessage.
import { App } from '@modelcontextprotocol/ext-apps';

type Tag = 'explicit' | 'clean' | 'ultra_hd' | 'hd' | 'dolby_atmos' | 'spatial' | 'lyrics' | 'ad_free';
type Rgb = [number, number, number];
type Quality = { label?: string | null; description?: string | null; track?: string | null; device?: string | null; output?: string | null };
type NowPlaying = {
  title: string | null;
  artist: string | null;
  album: string | null;
  artwork: string | null;
  state: 'playing' | 'paused' | 'none';
  position?: number;
  duration?: number;
  shuffle?: boolean;
  repeat?: 'off' | 'all' | 'one';
  liked?: boolean;
  volume?: number;
  tags?: Tag[];
  background?: string | null;
  lyricsAvailable?: boolean;
  lyrics?: { lines: string[]; activeIndex: number } | null;
  accent?: Rgb | null;
  accentMono?: boolean;
  quality?: Quality | null;
};
type QueueItem = { title: string | null; artist: string | null; album: string | null; href: string | null; artwork: string | null; tags?: Tag[] };
type UiState = { browser?: string; loggedIn?: boolean | null; now_playing?: NowPlaying | null; autoplay?: boolean | null; error?: string; hint?: string };
type HostCtx = { theme?: string; styles?: { variables?: Record<string, string | undefined>; css?: { fonts?: string } } };

const POLL_MS = 3000;
const LYRIC_POLL_MS = 1400;
const FOLLOW_RESUME_MS = 7000;

const TAG_LABEL: Record<Tag, string> = { explicit: 'E', clean: 'Clean', ultra_hd: 'Ultra HD', hd: 'HD', dolby_atmos: 'Atmos', spatial: '360', lyrics: 'Lyrics', ad_free: 'Ad-free' };
const TAG_TITLE: Record<Tag, string> = { explicit: 'Explicit', clean: 'Clean', ultra_hd: 'Ultra HD', hd: 'HD', dolby_atmos: 'Dolby Atmos', spatial: '360 Reality Audio', lyrics: 'Lyrics available', ad_free: 'Ad-free' };
const SHOWN_TAGS: Tag[] = ['explicit', 'ultra_hd', 'hd', 'dolby_atmos', 'spatial'];
const QUALITY_TAGS: Tag[] = ['ultra_hd', 'hd', 'dolby_atmos', 'spatial'];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  card: $('card'),
  skeleton: $('skeleton'),
  bg: $('bg'),
  empty: $('empty'),
  emptyText: $('emptyText'),
  emptyBtn: $<HTMLButtonElement>('emptyBtn'),
  main: $('main'),
  art: $<HTMLImageElement>('art'),
  artEmpty: $('artEmpty'),
  artSpin: $('artSpin'),
  meta: $('meta'),
  title: $('title'),
  artist: $('artist'),
  album: $('album'),
  tags: $('tags'),
  like: $<HTMLButtonElement>('like'),
  barFill: $('barFill'),
  pos: $('pos'),
  dur: $('dur'),
  shuffle: $<HTMLButtonElement>('shuffle'),
  prev: $<HTMLButtonElement>('prev'),
  play: $<HTMLButtonElement>('play'),
  playIcon: $('playIcon'),
  pauseIcon: $('pauseIcon'),
  next: $<HTMLButtonElement>('next'),
  repeat: $<HTMLButtonElement>('repeat'),
  rep1: $('rep1'),
  mute: $<HTMLButtonElement>('mute'),
  volIcon: $('volIcon'),
  muteIcon: $('muteIcon'),
  vol: $<HTMLInputElement>('vol'),
  volPct: $('volPct'),
  autoplayBtn: $<HTMLButtonElement>('autoplayBtn'),
  queueBtn: $<HTMLButtonElement>('queueBtn'),
  queuePanel: $('queuePanel'),
  queueHead: $('queueHead'),
  queueClose: $<HTMLButtonElement>('queueClose'),
  queueList: $('queueList'),
  lyricsBtn: $<HTMLButtonElement>('lyricsBtn'),
  lyricsPanel: $('lyricsPanel'),
  lyricsBox: $('lyrics'),
  followBtn: $<HTMLButtonElement>('followBtn'),
  foot: $('foot'),
  footText: $('footText'),
  footBtn: $<HTMLButtonElement>('footBtn'),
  status: $('status'),
};

const app = new App({ name: 'amazon-music-player', version: '0.7.0' });
let current: NowPlaying | null = null;
/**
 * The track this card is about. Once set it does not change on its own: a card in the
 * transcript should keep showing the song it was created for, even after the player has
 * moved on. The footer offers to follow the new track when they diverge.
 */
let pinnedKey: string | null = null;
let lastVolume = 100;
let fontsApplied = false;
let lyricsOpen = false;
let lyricsKey = '';
let lyricTimer: number | undefined;
let autoplayOn = false;
let autoplayKnown = false;
/**
 * An invocation of this card's tool is running. Until its result lands, the background poll
 * must not paint: it reports whatever the player bar happens to hold right now, which is
 * the *previous* track — so a card would open showing a song it isn't about.
 */
let toolPending = false;
/** Bumped on every invocation, so an in-flight poll started under the old one is discarded. */
let toolGen = 0;

const keyOf = (np: NowPlaying | null | undefined): string | null => (np?.title ? `${np.title}|${np.artist ?? ''}` : null);

/** `hidden` is a property on HTMLElement only; SVG icons need the attribute. */
function show(node: Element, visible: boolean): void {
  if (visible) node.removeAttribute('hidden');
  else node.setAttribute('hidden', '');
}

function fmt(s: number | undefined): string {
  if (!s || !Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function setStatus(text: string, err = false): void {
  el.status.textContent = text;
  el.status.classList.toggle('err', err);
}

// ---- accent colour, kept readable -----------------------------------------------------------

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const mx = Math.max(R, G, B);
  const mn = Math.min(R, G, B);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6;
  else if (mx === G) h = ((B - R) / d + 2) / 6;
  else h = ((R - G) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function relLuminance([r, g, b]: Rgb): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function readBg(): Rgb {
  const c = getComputedStyle(document.body).getPropertyValue('--bg').trim() || getComputedStyle(el.card).backgroundColor;
  const probe = document.createElement('span');
  probe.style.color = c;
  probe.style.display = 'none';
  document.body.append(probe);
  const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).color);
  probe.remove();
  if (!m) return [255, 255, 255];
  const [r, g, b] = m[1].split(',').map((n) => parseFloat(n));
  return [r, g, b];
}

/**
 * Text painted in the cover's colour still has to be readable. Keep the hue, then walk the
 * lightness away from the card background until it clears 4.5:1 — so a pale yellow cover
 * gives a deep gold on white, not an invisible one.
 */
function readableText(h: number, s: number, l: number, bg: Rgb): string {
  const bgLight = relLuminance(bg) > 0.4;
  let best = hslToRgb(h, s, l);
  let bestC = contrast(best, bg);
  const step = bgLight ? -0.03 : 0.03;
  for (let i = 0, cur = l; i < 24 && bestC < 4.5; i++) {
    cur = Math.max(0.06, Math.min(0.96, cur + step));
    const rgb = hslToRgb(h, s, cur);
    const c = contrast(rgb, bg);
    if (c > bestC) {
      bestC = c;
      best = rgb;
    }
  }
  return `rgb(${best[0]} ${best[1]} ${best[2]})`;
}

function applyAccent(accent: Rgb | null | undefined, mono = false): void {
  const root = document.documentElement;
  if (!accent) {
    for (const p of ['--accent', '--accent-text', '--accent-soft', '--accent-fg']) root.style.removeProperty(p);
    return;
  }
  const bg = readBg();
  const bgLight = relLuminance(bg) > 0.4;
  const [h, s0, l0] = rgbToHsl(accent);
  // A black-and-white cover has no hue to borrow: tint neutrally rather than inventing one.
  const s = mono ? Math.min(0.08, s0) : Math.min(0.85, Math.max(0.45, s0));
  const l = bgLight ? Math.min(0.56, Math.max(0.34, l0)) : Math.min(0.74, Math.max(0.5, l0));
  const fill = hslToRgb(h, s, l);
  root.style.setProperty('--accent', `rgb(${fill[0]} ${fill[1]} ${fill[2]})`);
  root.style.setProperty('--accent-text', readableText(h, s, l, bg));
  root.style.setProperty('--accent-soft', `rgba(${fill[0]}, ${fill[1]}, ${fill[2]}, .16)`);
  // Text drawn on top of the accent (the equaliser bars).
  root.style.setProperty('--accent-fg', contrast([255, 255, 255], fill) >= contrast([23, 22, 20], fill) ? '#fff' : '#171614');
}

// ---- host ------------------------------------------------------------------------------------

function applyHost(ctx: HostCtx | undefined): void {
  if (!ctx) return;
  if (ctx.theme === 'dark' || ctx.theme === 'light') document.documentElement.dataset.theme = ctx.theme;
  const vars = ctx.styles?.variables;
  if (vars) for (const [k, v] of Object.entries(vars)) if (v) document.documentElement.style.setProperty(k, v);
  const fonts = ctx.styles?.css?.fonts;
  if (fonts && !fontsApplied) {
    fontsApplied = true;
    const s = document.createElement('style');
    s.textContent = fonts;
    document.head.append(s);
  }
  applyAccent(current?.accent, current?.accentMono); // re-check contrast for the new theme
}

function parse(result: { content?: { type: string; text?: string }[]; isError?: boolean }): UiState & Record<string, unknown> {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return { error: text || 'empty result' };
  }
}

function showEmpty(text: string, button?: string, onClick?: () => void): void {
  el.skeleton.hidden = true;
  el.main.hidden = true;
  el.empty.hidden = false;
  el.card.classList.remove('playing', 'has-bg', 'stale');
  el.emptyText.textContent = text;
  el.emptyBtn.hidden = !button;
  el.emptyBtn.textContent = button ?? '';
  el.emptyBtn.onclick = onClick ?? null;
  notifySize();
}

/**
 * The card shows a shimmering skeleton until it has something real to draw — on first load
 * and while a new invocation is resolving — rather than an empty frame or a wrong track.
 */
let skeletonTimer: number | undefined;
function setCardLoading(on: boolean): void {
  clearTimeout(skeletonTimer);
  el.skeleton.hidden = !on;
  if (on) {
    el.main.hidden = true;
    el.empty.hidden = true;
    // If the invocation never reports back, fall back to whatever the player is doing
    // rather than leaving a skeleton on screen for ever.
    skeletonTimer = setTimeout(() => {
      if (el.skeleton.hidden) return;
      toolPending = false;
      void refresh(true);
    }, 12_000) as unknown as number;
  }
  notifySize();
}

/** Size messages are cheap but not free; one per frame is plenty. */
let sizeQueued = false;
function notifySize(): void {
  if (sizeQueued) return;
  sizeQueued = true;
  setTimeout(() => {
    sizeQueued = false;
    app.sendSizeChanged({ height: document.documentElement.scrollHeight }).catch(() => {});
  }, 60);
}

// ---- tags, with the real quality numbers on the badge -----------------------------------------

/** "24-bit / 48.0 kHz" -> "24-bit / 48 kHz". */
function tidyNumbers(v: string): string {
  return v
    .replace(/\s*\/\s*/, ' / ')
    .replace(/(\d+)\.0(\s*kHz)/i, '$1$2')
    .trim();
}

function tagChip(t: Tag, quality?: Quality | null, withNumbers = false): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'tag';
  if (t === 'explicit') s.classList.add('explicit');
  if (QUALITY_TAGS.includes(t)) s.classList.add('quality');
  s.append(document.createTextNode(TAG_LABEL[t]));
  // The badge itself carries the numbers, so nothing has to be hovered to see them.
  const numbers = withNumbers ? (quality?.output ?? quality?.track ?? null) : null;
  if (numbers) {
    const n = document.createElement('span');
    n.className = 'num';
    n.textContent = `· ${tidyNumbers(numbers)}`;
    s.append(n);
    s.title = [quality?.track && `Track: ${tidyNumbers(quality.track)}`, quality?.device && `This device: ${tidyNumbers(quality.device)}`, quality?.output && `Output: ${tidyNumbers(quality.output)}`, quality?.description]
      .filter(Boolean)
      .join('\n');
  } else {
    s.title = TAG_TITLE[t];
  }
  return s;
}

function renderTags(np: NowPlaying): void {
  el.tags.replaceChildren();
  // The numbers belong on one badge only — the best format present — not repeated on each.
  const primary = (['ultra_hd', 'dolby_atmos', 'hd', 'spatial'] as Tag[]).find((t) => np.tags?.includes(t)) ?? null;
  let i = 0;
  for (const t of SHOWN_TAGS) {
    if (!np.tags?.includes(t)) continue;
    const chip = tagChip(t, np.quality, t === primary);
    chip.style.animationDelay = `${i++ * 45}ms`;
    el.tags.append(chip);
  }
  el.tags.hidden = el.tags.childElementCount === 0;
}

// ---- lyrics ------------------------------------------------------------------------------------

let following = true;
let programmaticScroll = false;
let followTimer: number | undefined;
let releaseTimer: number | undefined;
let lastAutoTop = 0;
let scrollAnim: number | null = null;

el.lyricsBox.addEventListener('scroll', () => {
  if (programmaticScroll) return;
  noteManualScroll();
});

function noteManualScroll(): void {
  if (scrollAnim !== null) {
    cancelAnimationFrame(scrollAnim);
    scrollAnim = null;
  }
  if (following) {
    following = false;
    show(el.followBtn, true);
    notifySize();
  }
  clearTimeout(followTimer);
  followTimer = setTimeout(() => resumeFollow(), FOLLOW_RESUME_MS) as unknown as number;
}

function resumeFollow(): void {
  following = true;
  lastAutoTop = el.lyricsBox.scrollTop;
  show(el.followBtn, false);
  scrollToActive(true);
}

el.followBtn.onclick = () => {
  clearTimeout(followTimer);
  resumeFollow();
};

/**
 * Animated ourselves rather than with `scrollTo({behavior:'smooth'})`: the native easing is
 * inconsistent across embedders and cannot be cancelled cleanly when the reader grabs the
 * list mid-flight.
 */
function setScroll(top: number, smooth: boolean): void {
  const box = el.lyricsBox;
  if (scrollAnim !== null) cancelAnimationFrame(scrollAnim);
  programmaticScroll = true;
  clearTimeout(releaseTimer);
  lastAutoTop = top;
  const release = (): void => {
    releaseTimer = setTimeout(() => {
      programmaticScroll = false;
      lastAutoTop = box.scrollTop;
    }, 60) as unknown as number;
  };
  if (!smooth || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    box.scrollTop = top;
    scrollAnim = null;
    release();
    return;
  }
  const from = box.scrollTop;
  const delta = top - from;
  const dur = Math.min(620, Math.max(220, Math.abs(delta) * 1.6));
  const t0 = performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - t0) / dur);
    // easeInOutCubic
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    box.scrollTop = from + delta * e;
    if (t < 1) {
      scrollAnim = requestAnimationFrame(step);
    } else {
      scrollAnim = null;
      lastAutoTop = box.scrollTop;
      release();
    }
  };
  scrollAnim = requestAnimationFrame(step);
}

/** Some embedders don't deliver scroll events; also detect a manual scroll by position. */
function checkManualScroll(): boolean {
  if (!lyricsOpen || !following || programmaticScroll) return false;
  if (Math.abs(el.lyricsBox.scrollTop - lastAutoTop) <= 8) return false;
  noteManualScroll();
  return true;
}

function scrollToActive(smooth: boolean): void {
  if (!lyricsOpen) return;
  const box = el.lyricsBox;
  if (checkManualScroll()) return;
  if (!following) return;
  const active = box.querySelector('.now') as HTMLElement | null;
  if (!active) return;
  // offsetTop is relative to the nearest POSITIONED ancestor, which is the card, not this
  // scroll box — using it directly put the active line out of frame. Measure from the box.
  const lineTop = active.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  const max = Math.max(0, box.scrollHeight - box.clientHeight);
  const target = Math.min(max, Math.max(0, lineTop - box.clientHeight / 2 + active.offsetHeight / 2));
  if (Math.abs(box.scrollTop - target) < 4) return;
  setScroll(target, smooth);
}

function renderLyrics(np: NowPlaying): void {
  const lines = np.lyrics?.lines ?? [];
  const active = np.lyrics?.activeIndex ?? -1;
  const key = `${np.title}|${lines.length}`;
  if (key !== lyricsKey) {
    lyricsKey = key;
    el.lyricsBox.replaceChildren();
    if (lines.length === 0) {
      const d = document.createElement('div');
      d.className = 'none';
      d.textContent = np.lyricsAvailable ? 'Loading lyrics…' : 'No lyrics for this track.';
      el.lyricsBox.append(d);
    } else {
      for (const line of lines) {
        const d = document.createElement('div');
        d.textContent = line || '♪';
        el.lyricsBox.append(d);
      }
    }
    following = true;
    clearTimeout(followTimer);
    show(el.followBtn, false);
    setScroll(0, false);
    notifySize();
  }
  if (lines.length === 0) return;
  const kids = el.lyricsBox.children;
  let changed = false;
  for (let i = 0; i < kids.length; i++) {
    const d = kids[i] as HTMLElement;
    const isNow = i === active;
    if (isNow !== d.classList.contains('now')) changed = true;
    d.classList.toggle('now', isNow);
    d.classList.toggle('past', active >= 0 && i < active);
  }
  if (changed) scrollToActive(true);
}

function setLyricsOpen(open: boolean): void {
  lyricsOpen = open;
  el.lyricsPanel.hidden = !open;
  el.lyricsBtn.classList.toggle('on', open);
  clearInterval(lyricTimer);
  if (open) {
    closePanels('lyrics');
    following = true;
    show(el.followBtn, false);
    void call('lyrics');
    lyricTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void call('lyrics');
    }, LYRIC_POLL_MS) as unknown as number;
  } else {
    show(el.followBtn, false);
  }
  notifySize();
}

/** Only one panel at a time — the card stays compact. */
function closePanels(keep: 'lyrics' | 'queue' | 'none'): void {
  if (keep !== 'lyrics' && lyricsOpen) {
    lyricsOpen = false;
    clearInterval(lyricTimer);
    el.lyricsPanel.hidden = true;
    el.lyricsBtn.classList.remove('on');
    show(el.followBtn, false);
  }
  if (keep !== 'queue') {
    el.queuePanel.hidden = true;
    el.queueBtn.classList.remove('on');
  }
}

// ---- up next ------------------------------------------------------------------------------------

async function openQueue(): Promise<void> {
  if (!el.queuePanel.hidden) {
    closePanels('none');
    notifySize();
    return;
  }
  closePanels('queue');
  el.queueBtn.classList.add('on');
  el.queuePanel.hidden = false;
  el.queueHead.textContent = 'Loading…';
  el.queueList.replaceChildren();
  notifySize();
  const data = await call('queue');
  if (data.error) {
    el.queueHead.textContent = 'Up next';
    el.queueList.replaceChildren(noneRow(String(data.error)));
    notifySize();
    return;
  }
  const items = ((data.items as QueueItem[]) ?? []).filter((i) => i.title);
  // The first row is the track already playing; "up next" is what follows it.
  const upcoming = items.slice(1, 9);
  el.queueHead.textContent = upcoming.length ? `Up next · ${items.length - 1} queued` : 'Up next';
  el.queueList.replaceChildren();
  if (upcoming.length === 0) el.queueList.append(noneRow('Nothing queued after this track.'));
  upcoming.forEach((it, i) => el.queueList.append(queueRow(it, i + 1)));
  notifySize();
}

function noneRow(text: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'none';
  d.textContent = text;
  return d;
}

function queueRow(it: QueueItem, n: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  row.style.animationDelay = `${(n - 1) * 40}ms`;
  const num = document.createElement('span');
  num.className = 'n';
  num.textContent = String(n);
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  if (it.artwork) img.src = it.artwork;
  const meta = document.createElement('div');
  meta.className = 'rm';
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = it.title ?? '';
  const s = document.createElement('div');
  s.className = 's';
  const sub = document.createElement('span');
  sub.className = 'stext';
  sub.textContent = [it.artist, it.album].filter(Boolean).join(' · ');
  s.append(sub);
  for (const tag of SHOWN_TAGS) if (it.tags?.includes(tag)) s.append(tagChip(tag));
  meta.append(t, s);
  row.append(num, img, meta);
  if (it.href) {
    const go = document.createElement('span');
    go.className = 'go';
    go.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    row.append(go);
    row.classList.add('click');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.title = `Play ${it.title ?? ''}`;
    const play = async (): Promise<void> => {
      row.classList.add('loading');
      go.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8z"/></svg>';
      // Playing from the queue is a deliberate move, so this card follows along.
      pinnedKey = null;
      await call('play_href', { href: it.href });
      row.classList.remove('loading');
      closePanels('none');
      notifySize();
    };
    row.onclick = () => void play();
    row.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        void play();
      }
    };
  }
  return row;
}

// ---- render -------------------------------------------------------------------------------------

function render(state: UiState, fromTool = false): void {
  if (state.error) {
    if (state.error === 'not_logged_in') showEmpty('Not signed in to Amazon Music.', 'Open sign-in window', () => void call('login'));
    else showEmpty(state.error + (state.hint ? ` — ${state.hint}` : ''));
    return;
  }
  if (state.browser === 'not_started') {
    showEmpty('The background player is not running.', 'Start', () => void refresh());
    return;
  }
  if (state.loggedIn === false) {
    showEmpty('Not signed in to Amazon Music.', 'Open sign-in window', () => void call('login'));
    return;
  }
  const incoming = state.now_playing ?? null;
  const incomingKey = keyOf(incoming);

  // This card is pinned to its own song. If the player has moved on, keep showing ours and
  // offer to follow, rather than silently becoming a different track.
  if (pinnedKey && incomingKey && incomingKey !== pinnedKey && !fromTool) {
    el.card.classList.add('stale');
    el.foot.hidden = false;
    el.footText.textContent = `Now playing: ${incoming?.title ?? ''}`;
    el.footBtn.onclick = () => {
      pinnedKey = incomingKey;
      el.card.classList.remove('stale');
      el.foot.hidden = true;
      render({ browser: 'running', loggedIn: true, now_playing: incoming });
    };
    for (const b of [el.prev, el.play, el.next, el.shuffle, el.repeat, el.like]) b.disabled = true;
    clockRunning = false;
    notifySize();
    return;
  }
  el.card.classList.remove('stale');
  el.foot.hidden = true;

  const np = incoming;
  const prev = current;
  current = np;
  if (!np?.title) {
    showEmpty('Nothing is playing.');
    return;
  }
  if (!pinnedKey) pinnedKey = incomingKey;

  const trackChanged = !prev || keyOf(prev) !== incomingKey;
  const wasHidden = el.main.hidden;
  el.skeleton.hidden = true;
  el.empty.hidden = true;
  el.main.hidden = false;

  // Only crossfade between two real tracks; the first paint must be immediate.
  if (trackChanged && !wasHidden && prev?.title) {
    el.meta.classList.add('swap');
    el.art.classList.add('swap');
    setTimeout(() => {
      writeTrack(np);
      el.meta.classList.remove('swap');
      el.art.classList.remove('swap');
    }, 190);
  } else {
    writeTrack(np);
  }

  applyAccent(np.accent, np.accentMono);
  const playing = np.state === 'playing';
  el.card.classList.toggle('playing', playing);
  show(el.playIcon, !playing);
  show(el.pauseIcon, playing);
  el.play.title = playing ? 'Pause' : 'Play';
  el.shuffle.classList.toggle('on', !!np.shuffle);
  el.shuffle.title = np.shuffle ? 'Shuffle on' : 'Shuffle off';
  const rep = np.repeat ?? 'off';
  el.repeat.classList.toggle('on', rep !== 'off');
  show(el.rep1, rep === 'one');
  el.repeat.title = rep === 'one' ? 'Repeating this song' : rep === 'all' ? 'Repeating all' : 'Repeat off';
  el.like.classList.toggle('on', !!np.liked);
  el.like.title = np.liked ? 'Liked' : 'Like';
  for (const b of [el.prev, el.play, el.next, el.shuffle, el.repeat, el.like]) b.disabled = false;
  show(el.lyricsBtn, !!np.lyricsAvailable);
  show(el.queueBtn, true);
  show(el.autoplayBtn, autoplayKnown);
  el.autoplayBtn.classList.toggle('on', autoplayOn);
  el.autoplayBtn.title = autoplayOn ? 'Autoplay on — similar tracks continue after the queue' : 'Autoplay off — playback stops at the end of what you asked for';
  if (!np.lyricsAvailable && lyricsOpen) setLyricsOpen(false);
  else if (lyricsOpen) renderLyrics(np);
  if (typeof np.volume === 'number') setVolumeUi(np.volume);

  syncClock(np);
  setStatus('');
  if (wasHidden || trackChanged) notifySize();
}

function writeTrack(np: NowPlaying): void {
  el.title.textContent = np.title;
  el.title.title = np.title ?? '';
  el.artist.textContent = np.artist ?? '';
  el.album.textContent = np.album ? ` · ${np.album}` : '';
  renderTags(np);
  if (np.artwork) {
    if (el.art.src !== np.artwork) el.art.src = np.artwork;
    el.art.hidden = false;
    el.artEmpty.hidden = true;
  } else {
    el.art.hidden = true;
    el.artEmpty.hidden = false;
  }
  if (np.background) {
    const url = `url("${np.background.replace(/"/g, '%22')}")`;
    if (el.bg.style.backgroundImage !== url) el.bg.style.backgroundImage = url;
    el.card.classList.add('has-bg');
  } else {
    el.card.classList.remove('has-bg');
  }
}

function setVolumeUi(v: number): void {
  if (document.activeElement !== el.vol) el.vol.value = String(v);
  el.vol.style.setProperty('--fill', `${v}%`);
  el.vol.title = `Volume ${v}`;
  el.volPct.textContent = String(v);
  const muted = v === 0;
  show(el.volIcon, !muted);
  show(el.muteIcon, muted);
  if (v > 0) lastVolume = v;
}

// ---- progress clock -----------------------------------------------------------------------------

let clockPos = 0;
let clockAt = 0;
let clockDur = 0;
let clockRunning = false;
let lastShownSec = -1;

function syncClock(np: NowPlaying): void {
  clockPos = np.position ?? 0;
  clockDur = np.duration ?? 0;
  clockAt = performance.now();
  clockRunning = np.state === 'playing';
  lastShownSec = -1;
  drawProgress();
}

function drawProgress(): void {
  const pos = clockRunning ? Math.min(clockDur || Infinity, clockPos + (performance.now() - clockAt) / 1000) : clockPos;
  el.barFill.style.transform = `scaleX(${clockDur > 0 ? Math.min(1, pos / clockDur) : 0})`;
  const sec = Math.floor(pos);
  if (sec !== lastShownSec) {
    lastShownSec = sec;
    el.pos.textContent = fmt(pos);
    el.dur.textContent = fmt(clockDur);
  }
}

function frame(): void {
  drawProgress();
  requestAnimationFrame(frame);
}

// ---- server calls -------------------------------------------------------------------------------

function npFrom(data: Record<string, unknown>): NowPlaying | null {
  const np = data.now_playing as NowPlaying | undefined;
  if (np && typeof np === 'object') return np;
  const d = data as unknown as NowPlaying;
  return typeof d.state === 'string' && 'title' in d ? d : null;
}

/** Calls that make music start: show the buffering spinner until audio actually flows. */
const LOADING_CALLS = new Set(['play_href', 'next', 'previous', 'play']);

/**
 * One call at a time, queued rather than dropped. Dropping them (the old `busy` guard) made
 * clicks vanish and left the UI showing optimistic state that was never confirmed.
 */
let chain: Promise<unknown> = Promise.resolve();
let inFlight = 0;

function call(name: string, args: Record<string, unknown> = {}): Promise<UiState & Record<string, unknown>> {
  const run = async (): Promise<UiState & Record<string, unknown>> => {
    inFlight++;
    el.card.classList.add('busy');
    if (LOADING_CALLS.has(name)) show(el.artSpin, true);
    try {
      const res = await app.callServerTool({ name, arguments: args });
      const data = parse(res as never);
      if (name === 'lyrics') {
        if (Array.isArray(data.lines) && current) {
          current = { ...current, lyricsAvailable: true, lyrics: { lines: data.lines as string[], activeIndex: (data.activeIndex as number) ?? -1 } };
          renderLyrics(current);
        } else if (current) {
          renderLyrics({ ...current, lyricsAvailable: false, lyrics: null });
        }
        return data;
      }
      if (typeof data.autoplay === 'boolean') {
        autoplayOn = data.autoplay;
        autoplayKnown = true;
      }
      const np = npFrom(data);
      // A call this card made itself is deliberate, so it follows the result and re-pins.
      // The background poll is not: it stays silent while an invocation is still running.
      const fromTool = name !== 'ui_state';
      if (np) {
        if (fromTool) pinnedKey = keyOf(np);
        if (fromTool || !toolPending) render({ browser: 'running', loggedIn: true, now_playing: np }, fromTool);
      } else if (data.error) setStatus(String(data.error), true);
      return data;
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
      return { error: String(e) };
    } finally {
      inFlight--;
      if (inFlight === 0) {
        el.card.classList.remove('busy');
        show(el.artSpin, false);
      }
    }
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next as Promise<UiState & Record<string, unknown>>;
}

async function refresh(force = false): Promise<void> {
  if (!force && document.visibilityState !== 'visible') return;
  // Don't poll over an action the user just took; the action's own result renders.
  if (inFlight > 0) return;
  // Nor over an invocation still running, nor for a card frozen on a track the player has
  // left — in both cases the answer would be about a different song than this card is.
  if (toolPending || el.card.classList.contains('stale')) return;
  const gen = toolGen;
  const data = await call('ui_state');
  if (gen !== toolGen || toolPending) return;
  if (!data.error) render(data);
}

// ---- events -------------------------------------------------------------------------------------

el.play.onclick = () => {
  const playing = current?.state === 'playing';
  show(el.playIcon, playing);
  show(el.pauseIcon, !playing);
  el.card.classList.toggle('playing', !playing);
  clockPos = clockRunning ? clockPos + (performance.now() - clockAt) / 1000 : clockPos;
  clockRunning = !playing;
  clockAt = performance.now();
  void call('play_pause');
};
el.next.onclick = () => {
  pinnedKey = null; // the user asked to move on, so this card follows
  void call('next');
};
el.prev.onclick = () => {
  pinnedKey = null;
  void call('previous');
};
el.shuffle.onclick = () => {
  el.shuffle.classList.toggle('on', !current?.shuffle);
  void call('shuffle', { mode: current?.shuffle ? 'off' : 'on' });
};
el.repeat.onclick = () => {
  // Same cycle as Amazon Music's own button: off → all → one → off.
  const next = !current?.repeat || current.repeat === 'off' ? 'all' : current.repeat === 'all' ? 'one' : 'off';
  el.repeat.classList.toggle('on', next !== 'off');
  show(el.rep1, next === 'one');
  void call('repeat', { mode: next });
};
el.like.onclick = () => {
  const liked = !current?.liked;
  el.like.classList.toggle('on', liked);
  el.like.classList.remove('bump');
  void el.like.offsetWidth;
  if (liked) el.like.classList.add('bump');
  void call(current?.liked ? 'unlike' : 'like');
};
el.lyricsBtn.onclick = () => setLyricsOpen(!lyricsOpen);
el.queueBtn.onclick = () => void openQueue();
el.queueClose.onclick = () => {
  closePanels('none');
  notifySize();
};
el.autoplayBtn.onclick = () => {
  const next = !autoplayOn;
  autoplayOn = next; // optimistic; the tool result confirms
  el.autoplayBtn.classList.toggle('on', next);
  void (async () => {
    const r = await call('set_autoplay', { enabled: next });
    if (typeof r.enabled === 'boolean') {
      autoplayOn = r.enabled;
      autoplayKnown = true;
      el.autoplayBtn.classList.toggle('on', autoplayOn);
    }
  })();
};
el.mute.onclick = () => {
  const v = Number(el.vol.value) === 0 ? lastVolume || 50 : 0;
  setVolumeUi(v);
  void call('set_volume', { level: v });
};
el.vol.oninput = () => {
  const v = Number(el.vol.value);
  el.vol.style.setProperty('--fill', `${v}%`);
  el.volPct.textContent = String(v);
};
el.vol.onchange = () => {
  setVolumeUi(Number(el.vol.value));
  void call('set_volume', { level: Number(el.vol.value) });
};

// A new invocation is starting: this card is about whatever that call produces, and about
// nothing else until it lands.
app.ontoolinput = () => {
  pinnedKey = null;
  toolPending = true;
  toolGen++;
  setCardLoading(true);
};

app.ontoolresult = (params) => {
  const data = parse(params as never);
  const np = npFrom(data);
  toolPending = false;
  if (typeof data.autoplay === 'boolean') {
    autoplayOn = data.autoplay;
    autoplayKnown = true;
  }
  setCardLoading(false);
  // A tool result means Claude just acted, so the card follows it and re-pins to that
  // track. Only the background poll respects the pin, which is what stops a card in the
  // transcript from silently becoming a different song later.
  if (np) {
    pinnedKey = keyOf(np);
    render({ browser: 'running', loggedIn: true, now_playing: np }, true);
  } else {
    render(data);
  }
};
// A cancelled invocation is never going to report back; fall through to the live state
// rather than leaving the skeleton up until its safety timeout.
app.ontoolcancelled = () => {
  toolPending = false;
  setCardLoading(false);
  void refresh(true);
};
app.onhostcontextchanged = (ctx) => applyHost(ctx as HostCtx);

// ---- boot ---------------------------------------------------------------------------------------

const DEMO_LYRICS = [
  'One, two, three, four',
  'You stepped inside with a vibe I ain’t never seen',
  'Yes, you did, ooh',
  'So, girl, if you talk like you walk, come and talk to me',
  'But look here',
  'It would break my heart, break my heart',
  'If I find out you can’t move',
  'You better show me now, show me now',
  '’Cause when I take you to the floor',
  'You know what to do',
];

(async () => {
  requestAnimationFrame(frame);
  setInterval(checkManualScroll, 400);
  // The contrast correction depends on the background, so redo it if the theme flips.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAccent(current?.accent, current?.accentMono));
  if (location.search.includes('skeleton')) return; // the card starts in its loading state
  if (location.search.includes('demo')) {
    // Layout preview without an MCP host: node scripts/serve-ui.mjs → http://localhost:8765/?demo
    autoplayKnown = true;
    render({
      browser: 'running',
      loggedIn: true,
      now_playing: {
        title: 'One More Time',
        artist: 'Daft Punk',
        album: 'Discovery',
        artwork: null,
        background: 'https://m.media-amazon.com/images/I/81kpVSqpUyL._SX1920_SY1080_BL0_QL50_.jpg',
        state: 'playing',
        position: 75,
        duration: 320,
        shuffle: false,
        repeat: 'one',
        liked: true,
        volume: 40,
        tags: ['explicit', 'ultra_hd', 'dolby_atmos', 'lyrics'],
        lyricsAvailable: true,
        // ?accent=r,g,b lets the contrast correction be checked against awkward covers.
        accent: (new URLSearchParams(location.search).get('accent')?.split(',').map(Number) as Rgb) ?? [126, 74, 33],
        accentMono: location.search.includes('mono'),
        quality: { label: 'Ultra HD', track: '24-bit / 96.0 kHz', device: '24-bit / 48.0 kHz', output: '24-bit / 48.0 kHz', description: 'Lossless audio.' },
        lyrics: { lines: DEMO_LYRICS, activeIndex: 3 },
      },
    });
    if (location.search.includes('lyrics')) {
      lyricsOpen = true;
      el.lyricsPanel.hidden = false;
      el.lyricsBtn.classList.add('on');
      renderLyrics(current!);
    }
    if (location.search.includes('queue')) {
      el.queuePanel.hidden = false;
      el.queueBtn.classList.add('on');
      el.queueHead.textContent = 'Up next · 3 queued';
      el.queueList.replaceChildren(
        queueRow({ title: 'Digital Love', artist: 'Daft Punk', album: 'Discovery', href: '/a?trackAsin=3', artwork: null, tags: ['ultra_hd'] }, 1),
        queueRow({ title: 'Harder, Better, Faster, Stronger', artist: 'Daft Punk', album: 'Discovery', href: '/a?trackAsin=4', artwork: null, tags: ['hd'] }, 2),
        queueRow({ title: 'Around the World', artist: 'Daft Punk', album: 'Homework', href: '/a?trackAsin=5', artwork: null, tags: [] }, 3),
      );
    }
    if (location.search.includes('stale')) {
      el.card.classList.add('stale');
      el.foot.hidden = false;
      el.footText.textContent = 'Now playing: Instant Crush';
      for (const b of [el.prev, el.play, el.next, el.shuffle, el.repeat, el.like]) b.disabled = true;
    }
    return;
  }
  // Never open on an empty frame, and never on last song either: the card is loading until
  // it has an answer of its own.
  setCardLoading(true);
  try {
    await app.connect();
    applyHost(app.getHostContext() as HostCtx | undefined);
    // The Autoplay setting arrives with ui_state. Asking for it separately cost a whole
    // extra round trip before the first paint — and it opens a settings dialog on the site,
    // so it was the slowest thing the card did.
    setInterval(() => void refresh(), POLL_MS);
    document.addEventListener('visibilitychange', () => void refresh());
    await refresh();
  } catch (e) {
    showEmpty(`Could not connect to host: ${e instanceof Error ? e.message : String(e)}`);
  }
})();
