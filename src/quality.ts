import type { Page } from 'playwright-core';
import { CONFIG } from './config.js';
import { sleep } from './browser.js';
import { log } from './log.js';
import { SEL } from './selectors.js';

export interface AudioQuality {
  /** "HD", "ULTRA HD", "Dolby Atmos", ... as Amazon labels it. */
  label: string | null;
  /** One-line explanation Amazon shows under the label. */
  description: string | null;
  /** e.g. "16-bit / 44.1 kHz" — what the track itself offers. */
  track: string | null;
  /** What this device can play. */
  device: string | null;
  /** What is actually coming out. */
  output: string | null;
}

/**
 * Amazon only reveals real numbers behind the quality badge in the full Now Playing View:
 * clicking it opens a dialog reading e.g.
 *   "Track Quality: HD 16-bit / 44.1 kHz  Device: Edge Browser 16-bit / 44.1 kHz ..."
 * Opening it costs ~2 s, so results are cached per track.
 */
const cache = new Map<string, AudioQuality>();

/** Cached quality for a track, without triggering a read. */
export function peekQuality(trackKey: string): AudioQuality | undefined {
  return cache.get(trackKey);
}

/**
 * The dialog is line-oriented — the numbers sit on the line AFTER their label:
 *   AUDIO QUALITY: ULTRA HD / Ultra HD / Lossless audio that… /
 *   Track Quality: Ultra HD / 24-bit / 96.0 kHz / Device: Edge Browser / 24-bit / 48.0 kHz
 * so parse by line and never collapse the newlines away.
 */
export function parseDialog(raw: string): AudioQuality {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const after = (label: RegExp): string | null => {
    const i = lines.findIndex((l) => label.test(l));
    if (i < 0) return null;
    const own = /(\d+\s*-?\s*bit\s*\/\s*[\d.]+\s*k?Hz)/i.exec(lines[i]);
    if (own) return own[1];
    const next = lines[i + 1];
    return next && /\d/.test(next) ? next : null;
  };
  const label = /AUDIO QUALITY:?\s*(.+)/i.exec(lines.find((l) => /AUDIO QUALITY/i.test(l)) ?? '')?.[1]?.trim() ?? null;
  const description = lines.find((l) => /\b(lossless|immersive|spatial|standard)\b/i.test(l) && l.length > 25) ?? null;
  return { label, description, track: after(/^Track Quality/i), device: after(/^Device/i), output: after(/^Output/i) };
}

export async function audioQuality(p: Page, trackKey: string, ensureNpv: (p: Page, open: boolean) => Promise<boolean>): Promise<AudioQuality | null> {
  const hit = cache.get(trackKey);
  if (hit) return hit;
  const wasOpen = await p
    .locator(SEL.npv.root)
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  try {
    if (!wasOpen && !(await ensureNpv(p, true))) return null;
    const tag = p.locator(SEL.npv.qualityTag).first();
    if ((await tag.count()) === 0) return null;
    await tag.click({ timeout: 3000, force: true, noWaitAfter: true });
    const dialog = p.locator(SEL.menu.dialog).first();
    await dialog.waitFor({ state: 'visible', timeout: 4000 });
    await sleep(250);
    const text = (await dialog.innerText().catch(() => '')) || '';
    await p.keyboard.press('Escape').catch(() => {});
    await sleep(150);
    if (!text) return null;
    const q = parseDialog(text);
    cache.set(trackKey, q);
    if (cache.size > 30) cache.delete(cache.keys().next().value as string);
    return q;
  } catch (e) {
    log.warn('audio quality read failed', e);
    return null;
  } finally {
    if (!wasOpen) await ensureNpv(p, false).catch(() => {});
  }
}

void CONFIG;
