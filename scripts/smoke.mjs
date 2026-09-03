// Stdio smoke test: spawns the built server exactly like Claude Desktop would and calls a few tools.
// Run from the BUILD tree (it resolves the SDK from build/node_modules):
//   node %LOCALAPPDATA%\amazon-music-mcp\build\scripts\smoke.mjs [--play] [--quit]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const build = path.resolve(here, '..');
const root = path.resolve(build, '..');
const args = process.argv.slice(2);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(build, 'dist', 'index.js')],
  env: {
    ...process.env,
    AMZ_PROFILE_DIR: process.env.AMZ_PROFILE_DIR ?? path.join(root, 'profile'),
    AMZ_LOG_FILE: process.env.AMZ_LOG_FILE ?? path.join(root, 'logs', 'smoke.log'),
  },
  stderr: 'pipe',
});
transport.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));

const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const call = async (name, a = {}) => {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: a });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  console.log(`\n== ${name} (${Date.now() - t0} ms)${res.isError ? ' [ERROR]' : ''}`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2).slice(0, 3000));
  return { data, isError: !!res.isError };
};

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

let failures = 0;
const expect = (cond, msg) => {
  if (!cond) {
    failures++;
    console.log(`FAIL: ${msg}`);
  }
};

const status = await call('status');
const s = await call('search', { query: 'daft punk', limit: 8 });
expect(!s.isError, 'search errored');
if (!s.isError) expect(s.data.results.some((r) => r.type === 'song'), 'search returned no song result');

const snap = await call('debug_snapshot', { selector: '#music-navbar', maxChars: 1500 });
expect(!snap.isError, 'debug_snapshot errored');

const after = await call('status');
expect(after.data.browser === 'running', 'browser not running after search');
expect(after.data.visibility === 'visible', `page visibility is ${after.data.visibility}, expected visible`);

if (after.data.loggedIn === true && args.includes('--play')) {
  const pl = await call('play_by_query', { query: 'get lucky daft punk', type: 'song' });
  expect(!pl.isError, 'play_by_query errored');
  const np = await call('now_playing');
  expect(np.data.title, 'now_playing has no title');
  await call('pause');
  const paused = await call('now_playing');
  expect(paused.data.state === 'paused', `state after pause is ${paused.data.state}`);
} else if (after.data.loggedIn !== true) {
  console.log('\n(not logged in: playback checks skipped; run the login tool from Claude Desktop first)');
}

if (args.includes('--quit')) await call('quit_browser');

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
