// Dev utility: screenshots dist/ui/player.html in the background Edge (no MCP host, so the
// widget shows its "could not connect" state, but the layout is visible).
//   node build\scripts\shot-ui.mjs out.png
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const build = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const ctx = b.contexts()[0];
const p = await ctx.newPage();
try {
  await p.goto(pathToFileURL(path.join(build, 'dist', 'ui', 'player.html')).href, { waitUntil: 'load' });
  await p.setViewportSize({ width: 560, height: 540 });
  await new Promise((r) => setTimeout(r, 1500));
  await p.screenshot({ path: process.argv[2] });
  console.log('wrote', process.argv[2]);
} finally {
  await p.close().catch(() => {});
  await b.close();
}
