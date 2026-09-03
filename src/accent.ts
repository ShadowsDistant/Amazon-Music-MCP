import type { Page } from 'playwright-core';
import { log } from './log.js';

export type Rgb = [number, number, number];

/**
 * The album cover's signature colour, used to tint the player widget.
 *
 * Extracted in the page rather than in Node: m.media-amazon.com serves the artwork with
 * permissive CORS, so a canvas there can read the pixels (verified 2026-09-03), and Node
 * has no image decoder available here.
 *
 * Method: bin pixels by hue, weight each by chroma² and by how mid-range its brightness is,
 * then take the heaviest bin. That finds the gold on Daft Punk's black covers instead of the
 * black itself, which a plain "most common colour" would return.
 */
const EXTRACT = async (src: string): Promise<{ accent: Rgb; weight: number; mono: boolean } | null> => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  const ok = await new Promise<boolean>((res) => {
    img.onload = () => res(true);
    img.onerror = () => res(false);
    img.src = src;
  });
  if (!ok) return null;
  const N = 56;
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data;
  const bins = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  const sum = { r: 0, g: 0, b: 0 };
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    sum.r += d[i];
    sum.g += d[i + 1];
    sum.b += d[i + 2];
    const R = d[i] / 255;
    const G = d[i + 1] / 255;
    const B = d[i + 2] / 255;
    const mx = Math.max(R, G, B);
    const mn = Math.min(R, G, B);
    const ch = mx - mn;
    n++;
    if (ch < 0.09 || mx < 0.12) continue; // near-grey or near-black: no hue to speak of
    let h: number;
    if (mx === R) h = ((G - B) / ch + 6) % 6;
    else if (mx === G) h = (B - R) / ch + 2;
    else h = (R - G) / ch + 4;
    const mid = 1 - Math.abs(mx - 0.6) / 0.6;
    const w = ch * ch * Math.max(0.15, mid);
    const t = bins[Math.min(23, Math.floor((h / 6) * 24))];
    t.w += w;
    t.r += d[i] * w;
    t.g += d[i + 1] * w;
    t.b += d[i + 2] * w;
  }
  let best: (typeof bins)[number] | null = null;
  for (const t of bins) if (t.w > 0 && (!best || t.w > best.w)) best = t;
  if (n === 0) return null;
  const avg: Rgb = [Math.round(sum.r / n), Math.round(sum.g / n), Math.round(sum.b / n)];
  if (!best) return { accent: avg, weight: 0, mono: true };
  return { accent: [Math.round(best.r / best.w), Math.round(best.g / best.w), Math.round(best.b / best.w)], weight: best.w / n, mono: false };
};

function saturation([r, g, b]: Rgb): number {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

export interface Accent {
  rgb: Rgb;
  /** The artwork is black and white: the widget should tint neutrally, not invent a hue. */
  mono: boolean;
}

/** image URL -> accent (null = image unreadable, don't retry). */
const cache = new Map<string, Accent | null>();

async function extractOne(p: Page, src: string): Promise<Accent | null> {
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  let value: Accent | null = null;
  try {
    const r = await p.evaluate(EXTRACT, src);
    if (r) {
      // Reject noise: a near-greyscale image yields a washed-out "hue" from JPEG artefacts.
      const usableHue = !r.mono && r.weight > 0.0001 && saturation(r.accent) >= 0.22;
      value = { rgb: r.accent, mono: !usableHue };
    }
  } catch (e) {
    log.warn('accent extraction failed', e);
  }
  cache.set(src, value);
  if (cache.size > 60) cache.delete(cache.keys().next().value as string);
  return value;
}

/**
 * Accent for the current track. Some covers are genuinely black and white (Bruno Mars'
 * "The Romantic"), so a hue cannot be invented for them — fall back to the artist backdrop,
 * and if that is monochrome too, report the average tone with `mono` so the widget tints
 * neutrally instead of showing an unrelated colour.
 */
export async function accentFor(p: Page, artwork: string | null | undefined, backdrop?: string | null): Promise<Accent | null> {
  let fallback: Accent | null = null;
  if (artwork) {
    const fromCover = await extractOne(p, artwork);
    if (fromCover && !fromCover.mono) return fromCover;
    fallback = fromCover;
  }
  if (backdrop) {
    const fromBackdrop = await extractOne(p, backdrop);
    if (fromBackdrop && !fromBackdrop.mono) return fromBackdrop;
    fallback = fallback ?? fromBackdrop;
  }
  return fallback;
}
