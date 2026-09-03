// Call one or more tools against the built server over stdio, e.g.
//   node %LOCALAPPDATA%\amazon-music-mcp\build\scripts\call.mjs login
//   node ...\call.mjs play_by_query '{"query":"get lucky","type":"song"}' now_playing
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const build = path.resolve(here, '..');
const root = path.resolve(build, '..');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(build, 'dist', 'index.js')],
  env: {
    ...process.env,
    AMZ_PROFILE_DIR: process.env.AMZ_PROFILE_DIR ?? path.join(root, 'profile'),
    AMZ_LOG_FILE: process.env.AMZ_LOG_FILE ?? path.join(root, 'logs', 'call.log'),
  },
  stderr: 'pipe',
});
transport.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
const client = new Client({ name: 'call', version: '0.0.0' });
await client.connect(transport);

const argv = process.argv.slice(2);
let failed = false;
for (let i = 0; i < argv.length; i++) {
  const name = argv[i];
  let a = {};
  if (argv[i + 1]?.trim().startsWith('{')) a = JSON.parse(argv[++i]);
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: a });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  console.log(`\n== ${name} ${JSON.stringify(a)} (${Date.now() - t0} ms)${res.isError ? ' [ERROR]' : ''}\n${text}`);
  if (res.isError) failed = true;
}
await client.close();
process.exit(failed ? 1 : 0);
