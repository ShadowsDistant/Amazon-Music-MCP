import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

// stdout is the MCP transport. Everything here goes to stderr (and optionally a file).

let fileReady = false;

function fileWrite(line: string): void {
  if (!CONFIG.logFile) return;
  try {
    if (!fileReady) {
      fs.mkdirSync(path.dirname(CONFIG.logFile), { recursive: true });
      fileReady = true;
    }
    fs.appendFileSync(CONFIG.logFile, line + '\n');
  } catch {
    /* logging must never throw */
  }
}

function emit(level: string, msg: string, extra?: unknown): void {
  const stamp = new Date().toISOString();
  const tail = extra === undefined ? '' : ' ' + safeJson(extra);
  const line = `${stamp} [${level}] ${msg}${tail}`;
  process.stderr.write(line + '\n');
  fileWrite(line);
}

function safeJson(v: unknown): string {
  try {
    if (v instanceof Error) return JSON.stringify({ error: v.message, stack: v.stack });
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
};
