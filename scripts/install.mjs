// Merges the "amazon-music" server into Claude Desktop's config (idempotent, keeps a backup).
// Usage: node scripts/install.mjs [--config <path>] [--remove]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming');
const configPath = argValue('--config') ?? path.join(appData, 'Claude', 'claude_desktop_config.json');
// Runtime root lives in the user-profile root, not AppData (MSIX virtualization; see setup.ps1).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const nodeExe = process.execPath;

const entry = {
  command: nodeExe,
  args: [path.join(root, 'build', 'dist', 'index.js')],
  env: {
    AMZ_EDGE_EXE: fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
      ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    AMZ_PROFILE_DIR: path.join(root, 'profile'),
    AMZ_LOG_FILE: path.join(root, 'logs', 'server.log'),
  },
};

if (!fs.existsSync(entry.args[0])) {
  console.error(`Built server not found at ${entry.args[0]}. Run scripts\\setup.ps1 first.`);
  process.exit(1);
}

let cfg = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
  cfg = raw.trim() ? JSON.parse(raw) : {};
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = configPath.replace(/\.json$/i, `.backup-${stamp}.json`);
  fs.copyFileSync(configPath, backup);
  console.error(`Backup written: ${backup}`);
} else {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
}

cfg.mcpServers ??= {};
if (args.includes('--remove')) {
  delete cfg.mcpServers['amazon-music'];
} else {
  cfg.mcpServers['amazon-music'] = entry;
}

fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.error(`${args.includes('--remove') ? 'Removed' : 'Installed'} "amazon-music" in ${configPath}`);
console.error('Fully quit and relaunch Claude Desktop to pick it up.');
