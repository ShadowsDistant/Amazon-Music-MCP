// Dev utility: renders the widget with the REAL current player state and writes the README
// screenshots into assets/screenshots/.
//
//   node build\scripts\shots.mjs [outDir]
//
// Needs something loaded in the player (any track, playing or paused) and the background
// Edge running — it borrows that Edge over CDP rather than downloading a browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';

const build = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(build, '..');
const outDir = process.argv[2] ?? path.join(build, 'shots');
const widget = pathToFileURL(path.join(build, 'dist', 'ui', 'player.html')).href;

const json = (res) => JSON.parse(res.content?.find((c) => c.type === 'text')?.text ?? '{}');

// ---- real state ---------------------------------------------------------------------------

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(build, 'dist', 'index.js')],
  env: { ...process.env, AMZ_PROFILE_DIR: process.env.AMZ_PROFILE_DIR ?? path.join(root, 'profile') },
  stderr: 'ignore',
});
const client = new Client({ name: 'shots', version: '0.0.0' });
await client.connect(transport);

// The artist backdrop, the quality numbers and the Autoplay setting are all warmed in the
// background, so the first poll has none of them. Screenshots want the finished card.
let np = null;
for (let i = 0; i < 20; i++) {
  np = json(await client.callTool({ name: 'ui_state', arguments: {} })).now_playing;
  if (!np?.title) throw new Error('Nothing is loaded in the player — play something first.');
  if (np.background && np.quality?.label) break;
  await new Promise((r) => setTimeout(r, 700));
}
let lyrics = { available: false };
for (let i = 0; i < 3 && !lyrics.available; i++) lyrics = json(await client.callTool({ name: 'lyrics', arguments: {} }));
const queue = json(await client.callTool({ name: 'queue', arguments: {} }));
await client.close();

// Screenshots should show the player doing its job, not paused at 0:00.
const shot = {
  ...np,
  state: 'playing',
  position: np.position && np.position > 20 ? np.position : Math.round((np.duration ?? 200) * 0.31),
  volume: np.volume ?? 40,
  // The synced highlight only exists while the Now Playing View is open, so pick a line a
  // little way in — the screenshot is meant to show the follow behaviour, not line one.
  lyrics: lyrics.available ? { lines: lyrics.lines, activeIndex: lyrics.activeIndex > 0 ? lyrics.activeIndex : Math.min(6, Math.floor(lyrics.lines.length / 3)) } : null,
};
const shotQueue = (queue.items ?? []).slice(1, 4);
console.log(`state: ${shot.title} — ${shot.artist} | tags ${(shot.tags ?? []).join(',') || 'none'} | ${shot.lyrics?.lines.length ?? 0} lyric lines | ${shotQueue.length} queued | quality ${shot.quality ? (shot.quality.output || shot.quality.label) : "none"}`);

// ---- render -------------------------------------------------------------------------------

// A throwaway headless Edge, not the player's own: the server keeps that one down to two
// tabs and closes anything else, screenshot pages included.
const edge =
  process.env.AMZ_EDGE_EXE ??
  ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: edge, headless: true });
const ctx = await browser.newContext({ viewport: { width: 760, height: 900 }, deviceScaleFactor: 2 });
fs.mkdirSync(outDir, { recursive: true });

const SHOTS = [
  { file: 'player-dark.png', query: '?demo', theme: 'dark' },
  { file: 'player-light.png', query: '?demo', theme: 'light' },
  { file: 'player-lyrics.png', query: '?demo&lyrics', theme: 'dark' },
  { file: 'player-queue.png', query: '?demo&queue', theme: 'dark' },
  { file: 'player-loading.png', query: '?skeleton', theme: 'dark' },
];

for (const s of SHOTS) {
  const page = await ctx.newPage();
  try {
    await page.emulateMedia({ colorScheme: s.theme });
    await page.addInitScript(
      ([np, q]) => {
        window.__amzShot = np;
        window.__amzShotQueue = q;
      },
      [shot, shotQueue],
    );
    await page.goto(widget + s.query, { waitUntil: 'load' });
    // The card paints immediately; the artwork, the artist backdrop and the tag animations
    // do not, and a half-drawn card is a bad advert.
    await page.waitForTimeout(2500);
    await page.locator('#card').screenshot({ path: path.join(outDir, s.file) });
    console.log('wrote', path.join(outDir, s.file));
  } finally {
    await page.close().catch(() => {});
  }
}
await browser.close();
