// Bundles ui/player.ts into a single self-contained HTML file at dist/ui/player.html,
// and copies assets/ into dist/assets/. Run from the build tree (needs node_modules).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'ui');
fs.mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, 'ui', 'player.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  write: false,
  logLevel: 'warning',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const template = fs.readFileSync(path.join(root, 'ui', 'player.html'), 'utf8');
if (!template.includes('/*__BUNDLE__*/')) throw new Error('ui/player.html is missing the /*__BUNDLE__*/ placeholder');
const html = template.replace('/*__BUNDLE__*/', () => js);
fs.writeFileSync(path.join(outDir, 'player.html'), html, 'utf8');
console.error(`ui: wrote ${path.join(outDir, 'player.html')} (${(html.length / 1024).toFixed(0)} KB)`);

const assets = path.join(root, 'assets');
if (fs.existsSync(assets)) {
  fs.cpSync(assets, path.join(root, 'dist', 'assets'), { recursive: true });
  console.error('ui: copied assets');
}
