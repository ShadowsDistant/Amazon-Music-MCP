import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import {
  cdpAlive,
  ensureBrowsePage,
  ensurePage,
  getWindowBounds,
  hideWindow,
  isAttached,
  isLoggedIn,
  quitBrowser,
  showWindow,
  tabCount,
  visibility,
} from './browser.js';
import { CONFIG } from './config.js';
import { addToPlaylist, myPlaylists, playPlaylist } from './library.js';
import { log } from './log.js';
import { autoplay, ensureNpv, knownAutoplay, like, nowPlaying, nowPlayingLive, nowPlayingSynced, npvExclusive, queue, setPlayback, setRepeat, setShuffle, setVolume, skip, waitForTrack } from './player.js';
import { audioQuality, peekQuality } from './quality.js';
import { stopWatch, watchSingleTrack, type PlayIntent } from './singleTrack.js';
import { parseItems, playByQuery, playHref, queueAdd, search, settle } from './search.js';
import { SEL } from './selectors.js';

const TOOL_TIMEOUT_MS = 40_000;
export const PLAYER_UI_URI = 'ui://amazon-music/player.html';

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(error: string, hint?: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error, hint }, null, 2) }], isError: true };
}

class ToolError extends Error {
  constructor(
    public code: string,
    public hint?: string,
  ) {
    super(code);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

/** Runs a tool body, converting throws into structured error results. */
async function run(name: string, body: () => Promise<unknown>): Promise<CallToolResult> {
  const t0 = Date.now();
  try {
    const r = ok(await withTimeout(body(), TOOL_TIMEOUT_MS, name));
    log.info(`tool ${name}`, { ms: Date.now() - t0 });
    return r;
  } catch (e) {
    if (e instanceof ToolError) return fail(e.code, e.hint);
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`tool ${name} failed`, e);
    const hint = /Timeout|timed out/i.test(msg)
      ? 'The page did not respond in time. Check `status` (visibility must be "visible"); call hide_window to re-normalize the window, or debug_snapshot to inspect the DOM.'
      : undefined;
    return fail(msg, hint);
  }
}

async function requireLogin(p: Page): Promise<Page> {
  const li = await isLoggedIn(p);
  if (li !== true) {
    throw new ToolError('not_logged_in', 'Call the login tool, sign in to Amazon Music in the Edge window it shows, then call hide_window.');
  }
  return p;
}

/** Player tab, signed in. */
const playerTab = async (): Promise<Page> => requireLogin(await ensurePage());
/** Browse tab, signed in (shares the profile, so the same session). */
const browseTab = async (): Promise<Page> => {
  await requireLogin(await ensurePage());
  return ensureBrowsePage();
};

const SearchType = z.enum(['song', 'album', 'artist', 'playlist', 'station', 'podcast', 'all']);

/**
 * State bundle the embedded player polls. Nothing in here may block: the Now Playing View
 * (backdrop, lyrics), the quality numbers and the Autoplay setting are all filled in from
 * caches and warmed in the background, so a poll is one round trip and the widget paints
 * immediately instead of waiting ~1 s on its first one.
 */
async function uiState(): Promise<Record<string, unknown>> {
  const running = isAttached() || (await cdpAlive());
  if (!running) return { browser: 'not_started', loggedIn: null, now_playing: null };
  const p = await ensurePage();
  const loggedIn = await isLoggedIn(p);
  const np = loggedIn === true ? await nowPlayingLive(p) : null;
  if (loggedIn === true) warmAutoplay();
  return { browser: 'running', loggedIn, autoplay: knownAutoplay(), now_playing: np ? { ...np, quality: await qualityFor(p, np) } : null };
}

/**
 * Reading Autoplay opens a settings dialog, so the widget must never do it just to draw its
 * toggle. Read it once in the background and serve `knownAutoplay()` from then on.
 */
let autoplayWarm: Promise<unknown> | null = null;
function warmAutoplay(): void {
  if (autoplayWarm || knownAutoplay() !== null) return;
  autoplayWarm = (async () => {
    await new Promise((r) => setTimeout(r, 1500)); // let whatever prompted this finish first
    await autoplay(await ensureBrowsePage());
  })().catch((e) => {
    autoplayWarm = null; // a failed read is worth retrying on the next poll
    log.warn('could not read the Autoplay setting', e);
  });
}

/**
 * Quality numbers for the badge. Reading them opens the Now Playing View, so the first poll
 * for a track kicks that off in the background and returns nothing; later polls get the
 * cached answer. The widget therefore fills the badge in a moment after the track starts,
 * instead of every poll paying ~1.8 s.
 */
const qualityWarmed = new Set<string>();
async function qualityFor(p: Page, np: { title: string | null; artist: string | null; tags: string[] }): Promise<unknown> {
  if (!np.title || !np.tags.some((t) => t === 'ultra_hd' || t === 'hd' || t === 'dolby_atmos' || t === 'spatial')) return undefined;
  const key = `${np.title}|${np.artist}`;
  const cached = peekQuality(key);
  if (cached) return cached;
  if (!qualityWarmed.has(key)) {
    qualityWarmed.add(key);
    if (qualityWarmed.size > 40) qualityWarmed.delete(qualityWarmed.values().next().value as string);
    // Serialised with the backdrop/lyrics harvest: both open the same Now Playing View.
    void npvExclusive(() => audioQuality(p, key, ensureNpv)).catch(() => {});
  }
  return undefined;
}

/**
 * Amazon queues "similar tracks" even after a single song, and Autoplay-off only stops that
 * queue from being *extended*. So when the user asked for one song and Autoplay is off,
 * arm a watcher that pauses the moment the player moves past it. Albums, playlists and
 * stations are collections — they are meant to keep going.
 */
async function armSingleTrackStop(p: Page, intent: PlayIntent, title: string | null): Promise<void> {
  stopWatch(p);
  if (intent !== 'single' || !title) return;
  // Reading Autoplay opens a settings dialog (~600 ms), which would be paid on every play.
  // When it is not known yet, arm anyway and let the background read disarm: the user asked
  // for one song, so stopping is the answer that matches the request if the read never lands.
  const known = knownAutoplay();
  if (known === true) return;
  watchSingleTrack(p, title);
  if (known === false) return;
  void (async () => {
    try {
      const { enabled } = await autoplay(await ensureBrowsePage());
      if (enabled) stopWatch();
    } catch (e) {
      log.warn('could not read Autoplay for single-track stop', e);
    }
  })();
}

/** now_playing for the model: everything except the full lyric list. */
function brief(np: Awaited<ReturnType<typeof nowPlaying>>): Omit<typeof np, 'lyrics'> {
  const { lyrics: _lyrics, ...rest } = np;
  return rest;
}

/** The widget is one static file; re-reading it per render only delays the first paint. */
let playerHtml: string | null = null;
function loadPlayerHtml(): string {
  if (playerHtml) return playerHtml;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, 'ui', 'player.html');
  try {
    playerHtml = fs.readFileSync(file, 'utf8');
    return playerHtml;
  } catch (e) {
    log.error('player.html missing; run scripts/setup.ps1', e);
    return '<!doctype html><p style="font-family:sans-serif">Player UI not built. Run scripts\\setup.ps1.</p>';
  }
}

export function registerTools(server: McpServer): void {
  const UI = { ui: { resourceUri: PLAYER_UI_URI } };
  const APP_ONLY = { ui: { resourceUri: PLAYER_UI_URI, visibility: ['app' as const] } };

  registerAppResource(server, 'Amazon Music Player', PLAYER_UI_URI, { description: 'Interactive Amazon Music player controls' }, async () => ({
    contents: [
      {
        uri: PLAYER_UI_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: loadPlayerHtml(),
        _meta: { ui: { csp: { resourceDomains: ['https://m.media-amazon.com', 'https://images-na.ssl-images-amazon.com'] }, prefersBorder: false } },
      },
    ],
  }));

  // ---- status / window -------------------------------------------------------------------------

  server.registerTool(
    'status',
    {
      title: 'Amazon Music status',
      description:
        'Amazon Music: report whether the background Edge tab is running, whether the user is signed in, and what is playing. Never launches Edge and never shows the widget. Use this when nothing is playing yet, or when the user asks whether music is set up.',
      inputSchema: {},
    },
    async () =>
      run('status', async () => {
        const running = isAttached() || (await cdpAlive());
        if (!running) {
          return { browser: 'not_started', loggedIn: null, hint: 'Any playback/search tool starts Edge automatically.' };
        }
        const p = await ensurePage();
        const [loggedIn, vis, np, window] = await Promise.all([isLoggedIn(p), visibility(p), nowPlaying(p), getWindowBounds(p)]);
        return { browser: 'running', loggedIn, url: p.url(), tabs: tabCount(), visibility: vis, window, playbackState: np.state, now_playing: np.title ? np : undefined };
      }),
  );

  server.registerTool(
    'login',
    {
      title: 'Amazon Music login',
      description:
        'Amazon Music: bring the Edge window to the front on the Amazon sign-in page so the user can sign in themselves (one-time). Call hide_window afterwards. Use when a tool reports not_logged_in.',
      inputSchema: {},
    },
    async () =>
      run('login', async () => {
        const p = await ensurePage();
        const already = await isLoggedIn(p);
        if (already !== true) {
          await p.goto(`${CONFIG.origin}/forceSignIn`, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
        }
        await showWindow(p);
        return {
          shown: true,
          window: await getWindowBounds(p),
          alreadyLoggedIn: already === true,
          instructions:
            already === true
              ? 'You are already signed in. Call hide_window to tuck the window away again.'
              : 'An Edge window is now on screen. Sign in to Amazon Music there (solve any CAPTCHA yourself), then call hide_window.',
        };
      }),
  );

  server.registerTool(
    'hide_window',
    {
      title: 'Hide Amazon Music window',
      description: 'Amazon Music: move the Edge windows off-screen again and drop their taskbar buttons (never minimized, because the player stops rendering when hidden). Also fixes a player that stopped responding after the window was minimized.',
      inputSchema: {},
    },
    async () =>
      run('hide_window', async () => {
        const p = await ensurePage();
        await hideWindow(p);
        return { hidden: true, visibility: await visibility(p), window: await getWindowBounds(p) };
      }),
  );

  server.registerTool(
    'quit_browser',
    { title: 'Quit Amazon Music browser', description: 'Amazon Music: close the background Edge instance entirely (stops playback). It relaunches on the next playback call.', inputSchema: {} },
    async () => run('quit_browser', async () => ({ closed: await quitBrowser() })),
  );

  // ---- player (with embedded UI) ---------------------------------------------------------------

  registerAppTool(
    server,
    'player',
    {
      title: 'Amazon Music player',
      description:
        'Amazon Music: show the interactive player widget (now playing, play/pause, skip, volume, shuffle, repeat, like, search). Only call this when something is already playing or paused; use status otherwise.',
      inputSchema: {},
      _meta: UI,
    },
    async () => run('player', async () => uiState()),
  );

  registerAppTool(
    server,
    'ui_state',
    { description: 'State bundle for the embedded player widget.', inputSchema: {}, _meta: APP_ONLY },
    async () => run('ui_state', async () => uiState()),
  );

  registerAppTool(
    server,
    'now_playing',
    {
      title: 'Now playing',
      description:
        'Amazon Music: the current track (title, artist, album, artwork, artist backdrop image, tags such as explicit / ultra_hd / hd / dolby_atmos, the lyric line being sung), playback state, position/duration, shuffle/repeat/like state. Use for "what is playing?", "what song is this?". Shows the player widget.',
      inputSchema: {},
      _meta: UI,
    },
    async () => run('now_playing', async () => brief(await nowPlaying(await playerTab(), true))),
  );

  server.registerTool(
    'lyrics',
    {
      title: 'Lyrics',
      description: 'Amazon Music: the full lyrics of the current track as lines, plus the index of the line being sung (synced lyrics). Use for "what are the lyrics", "what did they just sing".',
      inputSchema: {},
    },
    async () =>
      run('lyrics', async () => {
        const np = await nowPlayingSynced(await playerTab());
        if (!np.title) throw new ToolError('nothing_playing', 'Start something with play_by_query first.');
        if (!np.lyrics) return { title: np.title, artist: np.artist, available: false, note: 'Amazon Music has no lyrics for this track.' };
        return { title: np.title, artist: np.artist, available: true, activeIndex: np.lyrics.activeIndex, currentLine: np.currentLyric, lines: np.lyrics.lines };
      }),
  );

  registerAppTool(
    server,
    'audio_quality',
    {
      title: 'Audio quality',
      description:
        'Amazon Music: the current track\'s real playback quality numbers — bit depth and sample rate for the track, this device and the actual output, as Amazon reports them behind the HD/Ultra HD badge. Use for "what quality is this playing at?".',
      inputSchema: {},
      _meta: APP_ONLY,
    },
    async () =>
      run('audio_quality', async () => {
        const p = await playerTab();
        const np = await nowPlaying(p);
        if (!np.title) throw new ToolError('nothing_playing', 'Start something with play_by_query first.');
        const q = await audioQuality(p, `${np.title}|${np.artist}`, ensureNpv);
        if (!q) return { available: false, note: 'Amazon did not report quality details for this track.' };
        return { title: np.title, artist: np.artist, ...q };
      }),
  );

  server.registerTool(
    'set_autoplay',
    {
      title: 'Autoplay setting',
      description:
        'Amazon Music: read or change the account\'s Autoplay setting ("keep listening to similar tracks when your music ends"). Omit enabled to just read it. Use for "turn off autoplay", "stop playing similar songs after my playlist".',
      inputSchema: { enabled: z.boolean().optional() },
    },
    async ({ enabled }) => run('set_autoplay', async () => autoplay(await browseTab(), enabled)),
  );

  registerAppTool(server, 'play', { title: 'Play', description: 'Amazon Music: resume playback of the current track.', inputSchema: {}, _meta: UI }, async () =>
    run('play', async () => setPlayback(await playerTab(), 'play')),
  );
  server.registerTool('pause', { title: 'Pause', description: 'Amazon Music: pause playback.', inputSchema: {} }, async () =>
    run('pause', async () => setPlayback(await playerTab(), 'pause')),
  );
  server.registerTool('play_pause', { title: 'Play/pause', description: 'Amazon Music: toggle play/pause.', inputSchema: {} }, async () =>
    run('play_pause', async () => setPlayback(await playerTab(), 'toggle')),
  );
  registerAppTool(server, 'next', { title: 'Next track', description: 'Amazon Music: skip to the next track.', inputSchema: {}, _meta: UI }, async () =>
    run('next', async () => {
      const p = await playerTab();
      stopWatch(p); // moving on deliberately
      return skip(p, 'next');
    }),
  );
  registerAppTool(server, 'previous', { title: 'Previous track', description: 'Amazon Music: go back to the previous track.', inputSchema: {}, _meta: UI }, async () =>
    run('previous', async () => {
      const p = await playerTab();
      stopWatch(p);
      return skip(p, 'previous');
    }),
  );

  server.registerTool(
    'set_volume',
    { title: 'Set volume', description: 'Amazon Music: set the player volume, 0-100. Returns the full now-playing state.', inputSchema: { level: z.number().min(0).max(100) } },
    async ({ level }) => run('set_volume', async () => setVolume(await playerTab(), level)),
  );

  server.registerTool(
    'shuffle',
    { title: 'Shuffle', description: 'Amazon Music: turn shuffle on or off (toggles when mode is omitted). Returns the full now-playing state.', inputSchema: { mode: z.enum(['on', 'off']).optional() } },
    async ({ mode }) => run('shuffle', async () => setShuffle(await playerTab(), mode)),
  );

  server.registerTool(
    'repeat',
    {
      title: 'Repeat',
      description:
        'Amazon Music: set the repeat mode exactly like the Amazon Music button. "all" repeats the whole playlist/album/queue ("repeat this playlist"), "one" repeats only the current song ("repeat this song", "loop this"), "off" plays through once. Returns the full now-playing state including the resulting repeat mode.',
      inputSchema: { mode: z.enum(['off', 'all', 'one']) },
    },
    async ({ mode }) => run('repeat', async () => setRepeat(await playerTab(), mode)),
  );

  // ---- search / playback selection -------------------------------------------------------------

  server.registerTool(
    'search',
    {
      title: 'Search Amazon Music',
      description:
        'Amazon Music: search the catalog in the browse tab (playback is not interrupted). Returns ranked, typed results (song/album/artist/playlist/station/podcast) with hrefs usable by play_href or queue_add, plus tags (explicit, ultra_hd, hd, dolby_atmos, lyrics). Use when the user wants to find or choose between options. To just play something, prefer play_by_query.',
      inputSchema: { query: z.string().min(1), type: SearchType.optional(), limit: z.number().int().min(1).max(50).optional(), quick: z.boolean().optional() },
    },
    async ({ query, type, limit, quick }) =>
      run('search', async () => ({ query, results: await search(await ensureBrowsePage(), query, type ?? 'all', limit ?? 10, quick ?? false) })),
  );

  registerAppTool(
    server,
    'play_by_query',
    {
      title: 'Play music by name',
      description:
        'Amazon Music: search and immediately play the best match. THIS is the tool for "play <song/artist/album/playlist>" requests. Pass the user\'s words as query ("get lucky by daft punk", "the album discovery", "lofi playlist"); the words "album", "playlist", "station" and "<title> by <artist>" are understood. Set type only to force one kind. Returns what was played plus the other candidates.',
      inputSchema: { query: z.string().min(1), type: SearchType.optional() },
      _meta: UI,
    },
    async ({ query, type }) =>
      run('play_by_query', async () => {
        const p = await playerTab();
        const r = await playByQuery(p, query, type ?? 'all');
        if (!r) throw new ToolError('no_match', `Nothing found for "${query}"${type && type !== 'all' ? ` of type ${type}` : ''}.`);
        await armSingleTrackStop(p, r.intent, r.watch);
        const { watch: _watch, ...out } = r;
        return out;
      }),
  );

  registerAppTool(
    server,
    'play_href',
    {
      title: 'Play a search result',
      description: 'Amazon Music: play a specific search result by its href (from search, queue, or my_playlists).',
      inputSchema: { href: z.string().min(1) },
      _meta: UI,
    },
    async ({ href }) =>
      run('play_href', async () => {
        const p = await playerTab();
        const before = await nowPlaying(p);
        await playHref(p, href);
        const np = await waitForTrack(p, before, 7000);
        // A ?trackAsin= href is one song; an album/playlist href is a collection.
        await armSingleTrackStop(p, /trackAsin=/.test(href) ? 'single' : 'collection', np.changed ? np.title : null);
        return { played: href, now_playing: np };
      }),
  );

  server.registerTool(
    'queue_add',
    {
      title: 'Add to queue',
      description:
        'Amazon Music: add a song, album or playlist to the play queue without interrupting the current track. position "next" plays it right after the current track, "last" appends it. Use for "queue up X", "play X next", "add X to the queue". Give query (natural words) or an href from search.',
      inputSchema: { query: z.string().optional(), href: z.string().optional(), type: SearchType.optional(), position: z.enum(['next', 'last']).optional() },
    },
    async ({ query, href, type, position }) =>
      run('queue_add', async () => {
        const p = await playerTab();
        stopWatch(p); // the user is deliberately lining up more music
        return queueAdd(p, { query, href, type, position: position ?? 'last' });
      }),
  );

  server.registerTool(
    'open_url',
    {
      title: 'Open Amazon Music URL',
      description: 'Amazon Music: open a music.amazon.com URL or path (e.g. a search result href) in the browse tab and list what is on it. Playback is not interrupted and nothing starts playing.',
      inputSchema: { url: z.string().min(1) },
    },
    async ({ url }) =>
      run('open_url', async () => {
        const full = url.startsWith('/') ? `${CONFIG.origin}${url}` : url;
        const u = new URL(full);
        if (!/(^|\.)music\.amazon\.[a-z.]+$/i.test(u.hostname)) throw new ToolError('bad_url', 'Only music.amazon.* URLs are allowed.');
        const b = await ensureBrowsePage();
        await b.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await b.locator(SEL.itemReady).first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
        await settle(b, SEL.item, 1200);
        return { url: b.url(), title: await b.title(), items: (await parseItems(b)).slice(0, 50) };
      }),
  );

  // ---- library ---------------------------------------------------------------------------------

  server.registerTool('my_playlists', { title: 'My playlists', description: "Amazon Music: list the signed-in user's playlists (browse tab; playback continues).", inputSchema: {} }, async () =>
    run('my_playlists', async () => ({ playlists: await myPlaylists(await browseTab()) })),
  );

  registerAppTool(
    server,
    'play_playlist',
    {
      title: 'Play playlist',
      description: 'Amazon Music: play one of the user\'s own playlists by (partial) name, or any playlist/album by href. For "play my <name> playlist".',
      inputSchema: { name: z.string().optional(), href: z.string().optional() },
      _meta: UI,
    },
    async ({ name, href }) =>
      run('play_playlist', async () => {
        const p = await playerTab();
        stopWatch(p); // a playlist is meant to keep going
        return playPlaylist(p, await ensureBrowsePage(), { name, href });
      }),
  );

  server.registerTool('like', { title: 'Like track', description: 'Amazon Music: like the current track. Returns the full now-playing state.', inputSchema: {} }, async () =>
    run('like', async () => like(await playerTab(), true)),
  );
  server.registerTool('unlike', { title: 'Unlike track', description: 'Amazon Music: remove the like from the current track. Returns the full now-playing state.', inputSchema: {} }, async () =>
    run('unlike', async () => like(await playerTab(), false)),
  );

  server.registerTool(
    'add_to_playlist',
    { title: 'Add to playlist', description: 'Amazon Music: add the current track to one of the user\'s playlists by name.', inputSchema: { playlist: z.string().min(1) } },
    async ({ playlist }) => run('add_to_playlist', async () => addToPlaylist(await playerTab(), playlist)),
  );

  server.registerTool('queue', { title: 'Play queue', description: 'Amazon Music: list the upcoming tracks in the play queue, with tags.', inputSchema: {} }, async () =>
    run('queue', async () => queue(await playerTab())),
  );

  // ---- debugging -------------------------------------------------------------------------------

  server.registerTool(
    'debug_snapshot',
    {
      title: 'Debug snapshot',
      description: 'Amazon Music (maintenance): accessibility snapshot of the player or browse tab (or of a CSS selector), plus URL/visibility. Use only to repair selectors when a tool stops working.',
      inputSchema: { selector: z.string().optional(), tab: z.enum(['player', 'browse']).optional(), maxChars: z.number().int().min(500).max(100_000).optional() },
    },
    async ({ selector, tab, maxChars }) =>
      run('debug_snapshot', async () => {
        const p = tab === 'browse' ? await ensureBrowsePage() : await ensurePage();
        const loc = selector ? p.locator(selector).first() : p.locator('body');
        const snap = await loc.ariaSnapshot({ timeout: CONFIG.waitMs });
        const cap = maxChars ?? 20_000;
        return { url: p.url(), title: await p.title(), tab: tab ?? 'player', visibility: await visibility(p), loggedIn: await isLoggedIn(p), truncated: snap.length > cap, ariaSnapshot: snap.slice(0, cap) };
      }),
  );
}
