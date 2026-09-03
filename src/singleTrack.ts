import type { Page } from 'playwright-core';
import { log } from './log.js';
import { pauseNow, readTransport, toNowPlaying } from './player.js';
import { SEL } from './selectors.js';

/**
 * "Autoplay off" on Amazon means *the queue* stops being extended — but asking for one song
 * still queues similar ones, so playback rolls on into music the user never asked for.
 *
 * When a single song is played and Autoplay is off, a stopper is installed **inside the
 * page** that pauses at the end of that song. It lives in the page for two reasons: the
 * progress slider only reports whole seconds, so the exact moment has to be interpolated
 * locally, and a CDP round trip per poll would leave a second of the next track audible —
 * which is what the old Node-side watcher did.
 *
 * Asking for an album, playlist or station sets intent 'collection' and nothing is armed.
 */
export type PlayIntent = 'single' | 'collection';

/**
 * How early to pause, in seconds. The interpolated clock is good to about ±0.15 s, so this
 * clips at most half a second of (almost always) fade-out or silence. Stopping fractionally
 * early is much better than the alternative: the next track starting, and the player then
 * being left sitting on a song the user never asked for.
 */
const LEAD_S = 0.35;
/** The Node side only re-arms and covers a page reload, so it can be lazy. */
const WATCHDOG_MS = 2500;

interface StopperState {
  armed: boolean;
  fired: boolean;
  why: string | null;
}

let timer: NodeJS.Timeout | null = null;
let watching: { title: string; page: Page } | null = null;

/**
 * Stops watching. Pass the page whenever there is one: the stopper lives *in the page*, so
 * it outlives this process — a server that restarts, or one that is killed mid-song, would
 * otherwise leave an armed stopper behind that pauses the next thing the user plays.
 */
export function stopWatch(p?: Page): void {
  if (timer) clearInterval(timer);
  timer = null;
  const page = p ?? watching?.page ?? null;
  watching = null;
  if (page) void disarmStopper(page);
}

/** Installs (or replaces) the page-side stopper for `title`. */
function installStopper(p: Page, title: string): Promise<boolean> {
  return p
    .evaluate(
      ([rootSel, progSel, miniSel, watchTitle, lead]) => {
        interface StopWindow extends Window {
          __amzStop?: () => void;
          __amzStopFired?: boolean;
          __amzStopWhy?: string | null;
        }
        const w = window as StopWindow;
        w.__amzStop?.();

        const pauseButton = (): HTMLElement | null => {
          const root = document.querySelector(rootSel as string);
          if (!root) return null;
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
          return walk(root);
        };
        const barTitle = (): string | null => document.querySelector(miniSel as string)?.getAttribute('primary-text') ?? null;

        let lastVal = NaN;
        let lastAt = performance.now();
        let lastMax = NaN;
        let peak = 0;
        let interval = 0;
        let enforcer = 0;
        let attempts = 0;
        let observer: MutationObserver | null = null;
        let done = false;

        // One click is not enough: the player bar re-renders as a track ends, and a click
        // that lands mid-render is swallowed. Keep clicking until the button reads Play.
        const enforcePause = (): void => {
          const btn = pauseButton();
          if (!btn || attempts >= 8) {
            clearInterval(enforcer);
            return;
          }
          attempts++;
          btn.click();
        };

        const finish = (pause: boolean, why: string): void => {
          if (done) return;
          done = true;
          clearInterval(interval);
          observer?.disconnect();
          delete w.__amzStop;
          w.__amzStopWhy = why;
          if (pause) {
            w.__amzStopFired = true;
            enforcePause();
            enforcer = setInterval(enforcePause, 150) as unknown as number;
          }
        };

        const tick = (): void => {
          const prog = document.querySelector(progSel as string);
          if (!prog) return;
          const now = Number(prog.getAttribute('aria-valuenow'));
          const max = Number(prog.getAttribute('aria-valuemax'));
          if (!Number.isFinite(now) || !Number.isFinite(max) || max <= 0) return;
          const t = performance.now();
          // A different length means a different track is already loaded.
          if (Number.isFinite(lastMax) && Math.abs(max - lastMax) > 0.5) return finish(true, 'length');
          lastMax = max;
          // aria-valuenow only moves in whole seconds; time the step to recover the rest.
          if (now !== lastVal) {
            lastVal = now;
            lastAt = t;
          }
          // The slider steps once a second, so a longer gap means it is not running —
          // paused, or stalled. Cheaper and more reliable than reading the button, which
          // means walking the whole player bar's shadow DOM twelve times a second.
          if (t - lastAt > 1500) return;
          const est = now + (t - lastAt) / 1000;
          // Amazon zeroes the clock a beat *before* it renames the bar, and when a stream
          // stalls near the end it can skip the last seconds entirely — so a jump back from
          // near the end is an ended track, not a seek.
          if (peak > max - 12 && est < peak - 5) return finish(true, 'reset');
          if (est > peak) peak = est;
          if (max - est <= (lead as number)) finish(true, 'end');
        };

        w.__amzStop = () => finish(false, 'disarmed');
        w.__amzStopFired = false;
        w.__amzStopWhy = null;
        interval = setInterval(tick, 80) as unknown as number;

        // Backstop: if Amazon rolls on sooner than the estimate says, pause on the same tick
        // the player bar changes, so at most a few milliseconds of it is ever audible.
        const mini = document.querySelector(miniSel as string);
        if (mini) {
          observer = new MutationObserver(() => {
            if (barTitle() !== watchTitle) finish(true, 'rolled');
          });
          observer.observe(mini, { attributes: true, attributeFilter: ['primary-text'] });
        }
        return true;
      },
      [SEL.transport.root, SEL.transport.progress, SEL.transport.nowPlaying, title, LEAD_S] as const,
    )
    .catch(() => false);
}

function readStopper(p: Page): Promise<StopperState> {
  return p
    .evaluate(() => {
      const w = window as Window & { __amzStop?: () => void; __amzStopFired?: boolean; __amzStopWhy?: string | null };
      return { armed: typeof w.__amzStop === 'function', fired: !!w.__amzStopFired, why: w.__amzStopWhy ?? null };
    })
    .catch(() => ({ armed: false, fired: false, why: null }));
}

function disarmStopper(p: Page): Promise<void> {
  return p
    .evaluate(() => {
      (window as Window & { __amzStop?: () => void }).__amzStop?.();
    })
    .catch(() => undefined);
}

/** Begin watching; call once a single track has actually started. */
export function watchSingleTrack(p: Page, title: string | null): void {
  stopWatch();
  if (!title) return;
  watching = { title, page: p };
  log.info('single-track stop armed', { title });
  void installStopper(p, title);
  timer = setInterval(() => {
    void tick();
  }, WATCHDOG_MS);
  timer.unref?.();
}

async function tick(): Promise<void> {
  if (!watching) return stopWatch();
  const { page, title } = watching;
  try {
    const state = await readStopper(page);
    if (state.fired) {
      log.info('single-track stopped at end of song', { title, why: state.why });
      stopWatch();
      return;
    }
    const np = toNowPlaying(await readTransport(page));
    if (np.title && np.title !== title) {
      // Only reachable when the page-side stopper is gone (a reload wiped it).
      log.info('single-track rolled on; pausing', { was: title, now: np.title });
      stopWatch();
      if (np.state === 'playing') await pauseNow(page);
      return;
    }
    if (!state.armed) await installStopper(page, title);
  } catch (e) {
    log.warn('single-track watchdog failed', e);
    stopWatch();
  }
}

export function isWatching(): boolean {
  return !!watching;
}
