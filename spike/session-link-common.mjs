import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const WINDOW_MS = 10_000;

const LINK_DIR = join(homedir(), '.throughline', 'session-link');

export function ensureLinkDir() {
  mkdirSync(LINK_DIR, { recursive: true });
}

export function projectHash(cwd) {
  const normalized = String(cwd || '').toLowerCase().replace(/\\/g, '/');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function stateFilePath(cwd) {
  ensureLinkDir();
  return join(LINK_DIR, `${projectHash(cwd)}.json`);
}

export function logFilePath() {
  ensureLinkDir();
  return join(LINK_DIR, 'link.log');
}

export function readState(cwd) {
  const p = stateFilePath(cwd);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(cwd, state) {
  const p = stateFilePath(cwd);
  writeFileSync(p, JSON.stringify(state, null, 2));
}

export function appendLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  appendFileSync(logFilePath(), line);
}

export function readStdinSync() {
  try {
    const buf = readFileSync(0, 'utf8');
    return buf;
  } catch {
    return '';
  }
}
