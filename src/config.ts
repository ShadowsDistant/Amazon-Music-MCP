import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// NOT under AppData: Claude Desktop is an MSIX package, so anything it (or a child such as
// Edge) writes under AppData\Local is silently redirected into the package's LocalCache and
// invisible to the login-time launcher. The user-profile root is shared by everyone.
const runtimeRoot = process.env.AMZ_ROOT ?? path.join(os.homedir(), '.amazon-music-mcp');
const here = path.dirname(fileURLToPath(import.meta.url));

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findEdge(): string {
  if (process.env.AMZ_EDGE_EXE) return process.env.AMZ_EDGE_EXE;
  return EDGE_CANDIDATES.find((p) => fs.existsSync(p)) ?? EDGE_CANDIDATES[0];
}

export const CONFIG = {
  edgeExe: findEdge(),
  profileDir: process.env.AMZ_PROFILE_DIR ?? path.join(runtimeRoot, 'profile'),
  cdpPort: Number(process.env.AMZ_CDP_PORT ?? 9333),
  logFile: process.env.AMZ_LOG_FILE ?? '',
  homeUrl: 'https://music.amazon.com/',
  origin: 'https://music.amazon.com',
  window: { width: 1280, height: 900 },
  /** Off-screen position used to hide the window without minimizing it. */
  hiddenPos: { left: -32000, top: -32000 },
  shownPos: { left: 100, top: 100 },
  /** Upper bound for any single locator wait. */
  waitMs: 8000,
  /** scripts/ next to dist/ in the build tree. */
  scriptsDir: path.resolve(here, '..', 'scripts'),
  powershell: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
};

/**
 * Command line for the background Edge. Shared by the server's spawn path and
 * the login-time autostart launcher so both start an identical instance.
 * Nothing here makes the page start playing on its own: playback only begins
 * from an explicit click issued by a tool.
 */
export function edgeArgs(): string[] {
  return [
    `--user-data-dir=${CONFIG.profileDir}`,
    `--remote-debugging-port=${CONFIG.cdpPort}`,
    `--window-position=${CONFIG.hiddenPos.left},${CONFIG.hiddenPos.top}`,
    `--window-size=${CONFIG.window.width},${CONFIG.window.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    // This profile is automation-only: no extensions, ever (the user's normal Edge is untouched).
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-sync',
    // Keep an off-screen window "visible" to the page: the site only renders its
    // shadow DOM while document.visibilityState === 'visible'.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    CONFIG.homeUrl,
  ];
}
