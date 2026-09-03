// Polls the running Edge (CDP) until the Amazon Music tab is signed in, then exits 0.
// Usage: node %LOCALAPPDATA%\amazon-music-mcp\build\scripts\wait-login.mjs [maxMinutes=60]
import { chromium } from 'playwright-core';

const port = Number(process.env.AMZ_CDP_PORT ?? 9333);
const maxMs = Number(process.argv[2] ?? 60) * 60_000;
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

while (Date.now() - t0 < maxMs) {
  try {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
    try {
      while (Date.now() - t0 < maxMs) {
        const pages = b.contexts()[0]?.pages() ?? [];
        const p = pages.find((x) => x.url().startsWith('https://music.amazon.com')) ?? null;
        if (p) {
          const state = await p
            .evaluate(() => ({
              ready: !!document.querySelector('#music-navbar, music-app'),
              signIn: !!document.querySelector('music-button[href^="/forceSignIn"]'),
              url: location.href,
            }))
            .catch(() => null);
          if (state?.ready && !state.signIn && !/forceSignIn|hasSeenMusicAuthPage/.test(state.url)) {
            console.log(`LOGGED_IN ${state.url}`);
            await b.close();
            process.exit(0);
          }
        }
        await sleep(5000);
      }
    } finally {
      await b.close().catch(() => {});
    }
  } catch (e) {
    process.stderr.write(`waiting: ${e.message}\n`);
    await sleep(5000);
  }
}
console.log('TIMEOUT');
process.exit(2);
