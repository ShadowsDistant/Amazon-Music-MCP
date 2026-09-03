import type { Page } from 'playwright-core';
import { CONFIG } from './config.js';
import { ensureRendered, sleep } from './browser.js';
import { SEL } from './selectors.js';
import { ensureNpv, nowPlaying, transportButton, waitForTrack, type NowPlaying } from './player.js';
import { absoluteUrl, parseItems, settle, type SearchResult } from './search.js';

/** Lists playlists. Runs in the BROWSE tab (a full navigation) so playback is untouched. */
export async function myPlaylists(browse: Page): Promise<SearchResult[]> {
  await ensureRendered(browse);
  await browse.goto(`${CONFIG.origin}${SEL.library.playlistsPath}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await browse.locator(SEL.itemReady).first().waitFor({ state: 'attached', timeout: CONFIG.waitMs }).catch(() => {});
  await settle(browse, SEL.library.playlistItem, 2000);
  if (!browse.url().includes('/my/')) {
    throw new Error(`Redirected to ${browse.url()} — probably not logged in. Call login.`);
  }
  const items = await parseItems(browse, SEL.library.playlistItem);
  return items.filter((i) => i.type === 'playlist' || i.type === 'unknown').map((i) => ({ ...i, type: 'playlist' as const }));
}

export async function playPlaylist(
  player: Page,
  browse: Page,
  opts: { name?: string; href?: string },
): Promise<{ played: SearchResult; now_playing: NowPlaying }> {
  let target: SearchResult | undefined;
  if (opts.href) {
    target = { type: 'playlist', title: null, subtitle: null, href: opts.href, artwork: null, section: null, tags: [], explicit: false };
  } else if (opts.name) {
    const needle = opts.name.toLowerCase();
    const lists = await myPlaylists(browse);
    target = lists.find((l) => l.title?.toLowerCase() === needle) ?? lists.find((l) => l.title?.toLowerCase().includes(needle));
    if (!target) throw new Error(`No playlist matching "${opts.name}". Known: ${lists.map((l) => l.title).join(', ') || 'none'}`);
  } else {
    throw new Error('Provide name or href.');
  }
  const before = await nowPlaying(player);
  await player.goto(absoluteUrl(target.href!), { waitUntil: 'commit', timeout: 20_000 });
  await player.locator(SEL.detailPlayButton).first().click({ timeout: CONFIG.waitMs, noWaitAfter: true });
  return { played: target, now_playing: await waitForTrack(player, before, 7000) };
}

/** Adds the current track to a playlist through the player bar's context menu. */
export async function addToPlaylist(p: Page, playlist: string): Promise<{ ok: boolean; playlist: string; note?: string; menu?: string[] }> {
  await ensureRendered(p);
  await ensureNpv(p, false);
  const more = await transportButton(p, SEL.transport.more);
  if (!more) throw new Error('No context-menu control on the player bar. Is something playing?');
  await more.click({ timeout: CONFIG.waitMs, noWaitAfter: true });
  await p.locator(SEL.menu.root).first().waitFor({ state: 'attached', timeout: 4000 }).catch(() => {});
  await sleep(300);
  const entries: string[] = await p.locator(SEL.menu.item).evaluateAll((els) => els.map((e) => (e.getAttribute('primary-text') ?? e.textContent ?? '').replace(/\s+/g, ' ').trim()));
  const addIdx = entries.findIndex((l) => SEL.menu.addToPlaylist.test(l));
  if (addIdx < 0) {
    await p.keyboard.press('Escape').catch(() => {});
    return { ok: false, playlist, note: 'Context menu opened but no "Add to playlist" entry was found.', menu: entries };
  }
  await p.locator(SEL.menu.item).nth(addIdx).click({ timeout: CONFIG.waitMs, noWaitAfter: true });
  const dialog = p.locator(SEL.menu.dialog).first();
  await dialog.waitFor({ state: 'visible', timeout: CONFIG.waitMs });
  await sleep(400);
  const rows = dialog.locator(SEL.menu.dialogRow);
  const labels: string[] = await rows.evaluateAll((els) => els.map((e) => (e.getAttribute('primary-text') ?? e.textContent ?? '').replace(/\s+/g, ' ').trim()));
  const needle = playlist.toLowerCase();
  let idx = labels.findIndex((l) => l.toLowerCase() === needle);
  if (idx < 0) idx = labels.findIndex((l) => l.toLowerCase().includes(needle));
  if (idx < 0) {
    await p.keyboard.press('Escape').catch(() => {});
    return { ok: false, playlist, note: `The playlist picker opened but no entry matched "${playlist}".`, menu: labels.filter(Boolean) };
  }
  await rows.nth(idx).click({ timeout: CONFIG.waitMs, noWaitAfter: true });
  await sleep(600);
  if (await dialog.isVisible().catch(() => false)) await p.keyboard.press('Escape').catch(() => {});
  return { ok: true, playlist: labels[idx] };
}
