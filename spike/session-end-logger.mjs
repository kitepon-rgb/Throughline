#!/usr/bin/env node
// SPIKE ONLY: temporary SessionEnd payload logger for docs/12 A Phase 1.
// Removal: deregister this hook from ~/.claude/settings.json, then delete this file after the spike concludes.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

async function readStdin() {
  let raw = '';
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', resolve);
  });
  return raw;
}

function buildEntry(raw) {
  const entry = {
    received_at: new Date().toISOString(),
    received_at_ms: Date.now(),
    env_entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
    ppid: process.ppid,
  };

  if (raw.length === 0) {
    return { ...entry, empty_stdin: true, payload: null };
  }

  try {
    return { ...entry, payload: JSON.parse(raw) };
  } catch (err) {
    return {
      ...entry,
      parse_error: err instanceof Error ? err.message : String(err),
      raw_head: raw.slice(0, 500),
    };
  }
}

export async function run() {
  const raw = await readStdin();
  const entry = buildEntry(raw);
  const logPath = join(homedir(), '.throughline', 'logs', 'session-end-spike.log');

  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
}

run().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[session-end-spike] ${message}\n`);
  process.exit(1);
});
