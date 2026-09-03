// Dev utility: serves the built widget (dist/ui + dist/assets) on http://localhost:8765
// so it can be previewed in a browser without an MCP host. No dependencies.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dist = path.join(process.env.AMZ_ROOT ?? path.join(os.homedir(), '.amazon-music-mcp'), 'build', 'dist');
const port = Number(process.env.PORT ?? 8765);
const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.js': 'text/javascript' };

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const rel = url.pathname === '/' ? '/ui/player.html' : url.pathname;
    const file = path.normalize(path.join(dist, rel));
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => console.log(`serving ${dist} at http://localhost:${port}/`));
