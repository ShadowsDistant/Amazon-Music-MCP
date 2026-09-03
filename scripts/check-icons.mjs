// Prints what the server advertises at initialize: icons, title, instructions.
// Use it to confirm the connector artwork is actually being sent.
//   node build\scripts\check-icons.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const build = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(build, 'dist', 'index.js')],
  env: { ...process.env },
  stderr: 'ignore',
});
const client = new Client({ name: 'check-icons', version: '0.0.0' });
await client.connect(transport);

const info = client.getServerVersion();
console.log('name:       ', info.name);
console.log('title:      ', info.title);
console.log('version:    ', info.version);
console.log('websiteUrl: ', info.websiteUrl);
console.log('icons:');
for (const i of info.icons ?? []) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(i.src);
  console.log(`  ${(i.sizes ?? ['?']).join(',').padEnd(9)} ${i.mimeType.padEnd(15)} ${m ? `${Math.round(m[2].length * 0.75)} bytes` : i.src.slice(0, 60)}`);
}
if (!info.icons?.length) console.log('  (none — run scripts/make-icon.ps1 and rebuild)');
await client.close();
