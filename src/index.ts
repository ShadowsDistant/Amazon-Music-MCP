import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detach } from './browser.js';
import { log } from './log.js';
import { registerTools } from './tools.js';

// stdout is the MCP channel: never print to it. See log.ts.

const here = path.dirname(fileURLToPath(import.meta.url));

/** One version, from package.json, so the server and the extension manifest can't drift. */
function version(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Icons as data URIs, smallest first, in several sizes: a client that wants a 48px icon
 * should not have to pick a 512px one (or skip the set entirely). PNG before SVG because
 * the spec only requires clients to support PNG and JPEG.
 */
function loadIcons(): { src: string; mimeType: string; sizes?: string[] }[] {
  const icons: { src: string; mimeType: string; sizes?: string[] }[] = [];
  const add = (file: string, mimeType: string, sizes: string[]) => {
    try {
      const buf = fs.readFileSync(path.join(here, 'assets', file));
      icons.push({ src: `data:${mimeType};base64,${buf.toString('base64')}`, mimeType, sizes });
    } catch {
      /* optional */
    }
  };
  for (const px of [48, 96, 256, 512]) add(`icon-${px}.png`, 'image/png', [`${px}x${px}`]);
  if (icons.length === 0) add('icon.png', 'image/png', ['512x512']);
  add('icon.svg', 'image/svg+xml', ['any']);
  return icons;
}

const INSTRUCTIONS = `This server controls the user's Amazon Music account through a background Microsoft Edge tab.
It is the user's music player: whenever they ask to play, pause, resume, skip, shuffle, repeat, like, queue, or find music,
or ask what is playing, use these tools instead of answering from memory or saying you cannot control playback.
Nothing plays until you call a play tool; never start playback the user did not ask for.
- "Play <anything>" → play_by_query with the user's words as query (it understands "<title> by <artist>", "album", "playlist", "station").
- "Play my <name> playlist" → play_playlist.
- "Queue up X" / "play X next" / "add X to the queue" → queue_add (position next|last). Do not interrupt the current track for these.
- "What's playing?" → now_playing. "Show the player" → player (only when something is playing or paused).
- "Repeat this playlist/album" → repeat mode=all. "Repeat this song" / "loop this" → repeat mode=one. "Stop repeating" → mode=off.
- Results and now_playing carry tags: explicit, clean, ultra_hd, hd, dolby_atmos, spatial, lyrics. Mention them only when relevant.
- search, my_playlists and open_url use a second browse tab, so they never interrupt what is playing.
- "What are the lyrics" / "what did they just sing" → lyrics. "Turn off autoplay" → set_autoplay enabled=false.
- Nothing playing yet / setup questions → status (no widget).
- If a tool returns not_logged_in, call login, tell the user to sign in in the Edge window, then call hide_window.
Tools that render the player widget (player, now_playing, play_by_query, play_href, play_playlist, play, next, previous) show
interactive controls to the user; keep your own text to one short line when the widget is shown.`;

const server = new McpServer(
  {
    name: 'amazon-music',
    title: 'Amazon Music',
    version: version(),
    description: 'Control Amazon Music through a background Edge tab',
    websiteUrl: 'https://music.amazon.com/',
    icons: loadIcons(),
  },
  { instructions: INSTRUCTIONS },
);
registerTools(server);

async function shutdown(reason: string): Promise<void> {
  log.info(`shutting down (${reason}); Edge keeps running`);
  await detach();
  process.exit(0);
}

process.stdin.on('end', () => void shutdown('stdin closed'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

const transport = new StdioServerTransport();
await server.connect(transport);
log.info('amazon-music MCP server ready');
