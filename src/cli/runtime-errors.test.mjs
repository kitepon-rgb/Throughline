import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs, run } from './runtime-errors.mjs';
import { defaultFactoryReporterConfigPath } from '../runtime-error-store.mjs';

test('runtime-errors CLI: strict command surface accepts no raw payload options', () => {
  assert.deepEqual(parseArgs(['snapshot', '--after-cursor', '2', '--limit', '3', '--json']), {
    command: 'snapshot', json: true, afterCursor: 2, limit: 3, value: null,
  });
  assert.equal(parseArgs(['reopen', 'a'.repeat(64), '--json']).command, 'reopen');
  for (const args of [
    ['snapshot', '--stderr', 'secret', '--json'],
    ['snapshot', '--path', '/Users/private', '--json'],
    ['resolve', 'abc', '--context', 'secret', '--json'],
    ['diagnostics'],
  ]) assert.throws(() => parseArgs(args));
});

test('runtime-errors CLI: internal failure is fixed and does not reflect exceptions or paths', () => {
  const writes = { stdout: '', stderr: '' };
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => { writes.stdout += chunk; return true; };
  process.stderr.write = (chunk) => { writes.stderr += chunk; return true; };
  try {
    const exitCode = run(['snapshot', '--json'], {
      readSnapshot() { throw new Error('secret /Users/private stack'); },
    });
    assert.equal(exitCode, 1);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  assert.equal(writes.stdout, '');
  assert.equal(writes.stderr, '[runtime-errors] operation_failed\n');
});

test('runtime-errors CLI: snapshot and diagnostics are JSON-only and contain no state path', () => {
  const root = mkdtempSync(join(tmpdir(), 'throughline-runtime-cli-'));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
  };
  const configPath = defaultFactoryReporterConfigPath(env);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    schema_version: '1.0',
    host: { id: 'test-host', profile: process.platform === 'win32' ? 'windows-native' : 'mac' },
    collection: { enabled: true },
    reporting: { enabled: false },
  }));
  const bin = new URL('../../bin/throughline.mjs', import.meta.url);
  for (const args of [
    ['runtime-errors', 'snapshot', '--json'],
    ['runtime-errors', 'diagnostics', '--json'],
  ]) {
    const result = spawnSync(process.execPath, [fileURLToPath(bin), ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(typeof json.schema, 'string');
    assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
