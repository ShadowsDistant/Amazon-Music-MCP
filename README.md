# Amazon Music MCP

An MCP server for Claude Desktop that controls **Amazon Music's web player** by driving a
real Microsoft Edge tab in the background. No Amazon API, no tokens: it clicks the same
page you would.

> Unofficial and not affiliated with or endorsed by Amazon. It automates the web player in
> your own signed-in browser profile, for your own account. The server never sees your
> credentials — `login` shows you the Edge window and you sign in yourself.

- Real Edge (not a bundled Chromium) because Amazon Music streams with Widevine DRM.
- Headed window kept **off-screen** (never minimized: the player stops rendering when the
  tab is hidden) and **hidden from the taskbar** (tool-window style). Audio plays normally.
- Private Edge profile at `%USERPROFILE%\.amazon-music-mcp\profile` with **extensions and
  sync disabled**; your normal Edge is untouched. You sign in once.
- **Two tabs, each in its own off-screen window**: the player tab owns playback; a browse
  tab handles `search`, `my_playlists` and `open_url` so full page loads never interrupt
  the music. Anything beyond those two is closed.
- Why not `%LOCALAPPDATA%`: Claude Desktop is an MSIX package, so files its child
  processes (this server, the Edge it launches) write under AppData are silently
  redirected into the package's LocalCache and are invisible to the login-time launcher.
  `%USERPROFILE%\.amazon-music-mcp` is shared by everyone.
- **Never autoplays**: nothing starts until a play tool is called.
- Edge is spawned detached and attached over CDP, so music keeps playing when Claude
  Desktop restarts. Optionally it starts (silently) at Windows sign-in.
- Ships a compact **interactive player widget** (MCP Apps) styled like Claude's inline
  visualizations: now playing with quality tags, play/pause, skip, volume, shuffle,
  repeat, like, an **up-next** queue, an autoplay toggle, a **synced lyrics** panel with a
  scroll lock, and Amazon's own **artist backdrop** behind it. It only renders once a track
  is loaded. Searching is done by asking Claude, not from the card.
- **The widget tints itself with the album cover's colour** — extracted from the artwork in
  the browser page (the CDN allows CORS). Anything drawn in that colour that has to be
  *read* is contrast-corrected to at least 4.5:1 against the card, so a pale-yellow or
  near-black cover still gives legible text. Monochrome artwork tints neutrally.
- **Quality badges carry the real numbers** — "ULTRA HD · 24-bit / 48 kHz" — read from
  Amazon's own quality dialog.
- **Quality and content tags** — explicit, Ultra HD, HD, Dolby Atmos, 360, lyrics — on the
  current track, queue rows and search results (search rows expose only `explicit`; see
  Limitations).
- **Autoplay** ("keep listening to similar tracks when your music ends") can be read and
  switched off from Claude with `set_autoplay`, or from the widget's own toggle. With it
  off, asking for **one song stops at the end of that song** — Amazon queues "similar
  tracks" regardless, so the server watches for the player rolling on and pauses it.
  Albums, playlists and stations are collections and keep playing.
- The widget is **pinned to its track**: a card in the transcript keeps showing the song it
  was created for instead of silently becoming whatever is playing now, and offers a
  "Show" button when they diverge.
- Search goes through the site's own search box (about 1 s) and results are ranked by
  a query parser that understands "<title> by <artist>", "the album …", "… playlist".
  A "play X" request completes in **1.9–2.5 s** end to end, including Amazon's start-up
  buffering; asking for what is already playing answers in about 50 ms. Widget state polls
  cost 8–17 ms — anything slow (the Now Playing View, the quality numbers, the Autoplay
  setting) is warmed in the background and served from cache.
- Has its own icon and server instructions so Claude reaches for it when you ask to
  play or queue music.

## Requirements

- **Windows** (the off-screen window and taskbar handling are Win32-specific)
- **Node.js 20+** — the build scripts call `node.exe` / `npm-cli.js` from `%ProgramFiles%\nodejs`
- **Microsoft Edge** — a real Edge, because Amazon Music streams with Widevine DRM
- An **Amazon Music account** you can sign in to (Unlimited for HD / Ultra HD tags)
- **Claude Desktop** with MCP Apps support for the widget; the plain tools work without it

## Install as a Claude Desktop extension (recommended — this is what gives it an icon)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-extension.ps1
```

The second command writes `%USERPROFILE%\.amazon-music-mcp\amazon-music.mcpb`. Double-click
it (or drag it onto Claude Desktop → Settings → Extensions) to install.

Claude Desktop draws a **letter avatar** for servers listed in
`claude_desktop_config.json` and ignores the icons a server advertises over MCP; installed
extensions carry their own `icon.png`, which is why Filesystem and pdf-viewer show artwork.
Packaging as an extension is the only way to get a real icon.

After installing the extension, remove the older config entry so the connector is not
listed twice:

```bash
node "$HOME/.amazon-music-mcp/build/scripts/install.mjs" --remove
```

## Setup (manual config — no icon)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -Install -Autostart
```

`setup.ps1` copies the sources to `%USERPROFILE%\.amazon-music-mcp\build`, runs `npm`,
`tsc` and the widget bundler there (nothing heavy lands in OneDrive).

- `-Install` merges this entry into `%APPDATA%\Claude\claude_desktop_config.json`
  (a timestamped backup is written first):

  ```json
  "amazon-music": {
    "command": "C:\\Program Files\\nodejs\\node.exe",
    "args": ["C:\\Users\\<you>\\.amazon-music-mcp\\build\\dist\\index.js"],
    "env": {
      "AMZ_EDGE_EXE": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "AMZ_PROFILE_DIR": "C:\\Users\\<you>\\.amazon-music-mcp\\profile",
      "AMZ_LOG_FILE": "C:\\Users\\<you>\\.amazon-music-mcp\\logs\\server.log"
    }
  }
  ```

- `-Autostart` writes `Amazon Music MCP (background Edge).lnk` into your Startup folder
  (`shell:startup`). It runs a hidden launcher (`launch-edge.vbs` → `launch-edge.ps1` in
  `%USERPROFILE%\.amazon-music-mcp`) that starts the same off-screen Edge the server would
  and drops its taskbar button, so playback is ready the moment you sign in to Windows.
  Nothing plays until you ask. Remove it with
  `node "%USERPROFILE%\.amazon-music-mcp\build\scripts\autostart.mjs" --remove`.

Then **fully quit and relaunch Claude Desktop**.

### First use

1. Ask Claude to run `login`. An Edge window appears on the Amazon sign-in page.
2. Sign in yourself (including any CAPTCHA / 2FA).
3. Ask Claude to run `hide_window`.

The session lives in the private profile, so this is a one-time step.

## Tools

| Tool | Purpose |
|---|---|
| `status` | Browser running? Signed in? Page visibility, playback state. Never launches Edge. |
| `login` / `hide_window` / `quit_browser` | Show the window for sign-in, tuck it away, or close Edge. |
| `player` ⧉ | Show the interactive player widget. |
| `now_playing` ⧉ | Title, artist, album, artwork, artist backdrop, tags, state, position/duration, shuffle/repeat/like, current lyric line. |
| `lyrics` | Full lyrics as lines plus the index of the line being sung. |
| `audio_quality` | Real playback numbers — bit depth / sample rate for the track, device and output. |
| `set_autoplay {enabled?}` | Read or change Amazon's Autoplay setting. Omit `enabled` to just read it. |
| `play` ⧉, `pause`, `play_pause`, `next` ⧉, `previous` ⧉ | Transport. |
| `set_volume {level}` | 0-100. |
| `shuffle {mode?}` / `repeat {mode}` | on/off; off / all (repeat the playlist, album or queue) / one (repeat the current song). Both return the full now-playing state. |
| `search {query, type?, limit?}` | Ranked, typed results with hrefs and tags (explicit, ultra_hd, hd, dolby_atmos, lyrics). Browse tab. |
| `play_by_query {query, type?}` ⧉ | Parse the request, search, play the best match; returns the runner-up candidates too. |
| `play_href {href}` ⧉ | Play a specific result / queue row / playlist by href. |
| `queue_add {query?|href?, position?}` | "Play next" or "Add to queue" for a song/album/playlist without interrupting playback. |
| `open_url {url}` | Navigate to any music.amazon.com page. |
| `my_playlists` / `play_playlist {name?|href?}` ⧉ | Library playlists. |
| `like` / `unlike` / `add_to_playlist {playlist}` | Act on the current track. |
| `queue` | Upcoming tracks. |
| `debug_snapshot {selector?}` | Accessibility snapshot for repairing selectors. |

⧉ = renders the player widget in Claude Desktop (MCP Apps). The widget calls the same
tools back through the host; `ui_state` is a widget-only helper hidden from the model.

## Environment variables

| Variable | Default |
|---|---|
| `AMZ_EDGE_EXE` | first existing of `Program Files (x86)` / `Program Files` Edge path |
| `AMZ_PROFILE_DIR` | `%USERPROFILE%\.amazon-music-mcp\profile` |
| `AMZ_CDP_PORT` | `9333` |
| `AMZ_LOG_FILE` | unset (stderr only) |

## Testing without Claude Desktop

```powershell
& "C:\Program Files\nodejs\node.exe" "$HOME\.amazon-music-mcp\build\scripts\smoke.mjs" --play
```

Spawns the server over stdio exactly like Claude Desktop does, lists tools, runs
`status`, `search`, `debug_snapshot`, and (when signed in and `--play` is given)
`play_by_query` → `now_playing` → `pause`. Add `--quit` to close Edge at the end.

Call any tool directly (run from a bash-style shell so the JSON survives quoting):

```bash
node "$HOME/.amazon-music-mcp/build/scripts/call.mjs" play_by_query '{"query":"get lucky","type":"song"}' now_playing
```

To preview the widget's layout without an MCP host, run `node scripts/serve-ui.mjs` and
open `http://localhost:8765/?demo` (a fake "Get Lucky" state; drop `?demo` to see the
empty state); `?skeleton` shows the loading card and `?demo&lyrics` / `?demo&queue` the
panels. Every tool logs its duration to stderr; `play_by_query` also logs a per-phase
breakdown (`search`, `pick`, `click`, `playing`), and `waitForTrack` / `single-track`
lines say what the player actually did. When playback misbehaves, read those first.

## Limitations

- **Search rows carry only `explicit`.** Amazon's search payload has no quality badges —
  the Ultra HD / HD / Atmos chips exist only on the player bar, in the queue and on detail
  pages, so that is where those tags come from. Verified against the live DOM, not assumed.
- **The connector icon needs the extension install.** The server also advertises icons over
  MCP (`serverInfo.icons`, verify with `scripts/check-icons.mjs`), but Claude Desktop
  ignores those for config-file servers.
- **Lyrics and the artist backdrop live in the full Now Playing View**, which must be
  closed for row-based tools (search, play, queue) to work. The server opens it once per
  track, harvests both, caches them, and closes it again — so the first read of a new track
  costs about 400 ms and later ones are instant. The synced highlight (`activeIndex`) is
  only live while that view is open, which the `lyrics` tool arranges; otherwise the lines
  come back with `activeIndex: -1`.

## Troubleshooting

- **Tools time out / return empty**: run `status`. `visibility` must be `visible`. If it is
  `hidden` (you minimized the Edge window, locked the screen, ...), call `hide_window`,
  which re-normalizes the window off-screen.
- **`not_logged_in`**: run `login`, sign in, `hide_window`.
- **A selector stopped matching** (Amazon changed the page): call `debug_snapshot`
  (optionally with a CSS selector) and update `src/selectors.ts`. Everything site-specific
  is in that one file.
- **No sound**: check the Edge window is not muted (`login` shows it) and that the DRM
  component loaded (`edge://components`, "Widevine Content Decryption Module").
- **Widget shows "Could not connect to host"**: the Claude Desktop build does not support
  MCP Apps; the plain tool results still work.
- **Edge shows up in the taskbar again**: call `hide_window` (it re-applies
  `scripts/taskbar.ps1`), or run that script by hand with `-ProfileDir`.
- **More than two Edge windows / tabs**: the server keeps the player tab plus one browse
  tab and closes the rest on every attach; `quit_browser` then any play tool gives a
  clean restart.
- **Logs**: `%USERPROFILE%\.amazon-music-mcp\logs\server.log` and Claude Desktop's
  `%APPDATA%\Claude\logs\mcp-server-amazon-music.log`. The server never writes to stdout.
- **Remove**: `node "%USERPROFILE%\.amazon-music-mcp\build\scripts\install.mjs" --remove`
  and `... autostart.mjs --remove`.

## Layout

```
src/index.ts        server bootstrap (stdio), icon + instructions
src/tools.ts        tool schemas + registration, widget resource, error wrapping
src/browser.ts      spawn/attach Edge over CDP, show/hide window, login detection
src/config.ts       paths + the shared Edge command line
src/selectors.ts    every site-specific selector
src/tags.ts         explicit / Ultra HD / HD / Atmos tag parsing
src/accent.ts       album-cover colour extraction (runs in the page, cached per artwork)
src/quality.ts      the real bit-depth / sample-rate numbers behind the HD badge
src/singleTrack.ts  the in-page end-of-song stop for single-track requests
src/player.ts       now_playing, transport, volume, shuffle/repeat, like, queue
src/search.ts       query parsing + ranking, search, play_by_query / play_href, queue_add
src/library.ts      playlists, add_to_playlist
ui/player.html+ts   the MCP App widget (bundled by scripts/build-ui.mjs)
assets/icon.*       server icon (make-icon.ps1 renders the PNG)
scripts/setup.ps1   build into %USERPROFILE%\.amazon-music-mcp (outside OneDrive)
scripts/install.mjs merge/remove the Claude Desktop config entry
scripts/autostart.mjs  create/remove the Startup-folder shortcut + hidden launcher
scripts/taskbar.ps1 hide/restore the Edge window's taskbar button (Win32 via PowerShell)
scripts/smoke.mjs, call.mjs, serve-ui.mjs   test utilities
```

## Development

`scripts/setup.ps1` is the build: it syncs `src`, `ui`, `scripts` and `assets` into
`%USERPROFILE%\.amazon-music-mcp\build`, installs dependencies there, runs `tsc`, and
bundles the widget into a single self-contained `dist/ui/player.html`. Nothing heavy is
written back into the source tree, so it is safe under OneDrive.

Everything site-specific lives in `src/selectors.ts`. When Amazon changes the page, that
is the file to fix — use `debug_snapshot` to see the accessibility tree first.

Amazon Music is built from Stencil web components with **open** shadow roots, so ordinary
CSS selectors pierce them in Playwright. Two consequences worth knowing before changing
anything: result rows exist as empty skeletons before they hydrate (hence
`itemReady`, which requires `[primary-text]`), and the full Now Playing View overlays both
the navbar and the player bar, so it must be closed before any row or transport click.

## Licence

No licence has been chosen yet, so default copyright applies: the code is readable here
but not licensed for reuse. Add a `LICENSE` file to change that.
