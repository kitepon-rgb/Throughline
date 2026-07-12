import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acknowledgeRuntimeErrors,
  compactRuntimeErrors,
  defaultFactoryReporterConfigPath,
  defaultRuntimeErrorStorePath,
  getRuntimeErrorDiagnostics,
  observeRuntimeError,
  readRuntimeErrorSnapshot,
  reopenRuntimeError,
  resolveRuntimeError,
} from './runtime-error-store.mjs';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'throughline-runtime-errors-'));
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
  };
  const configPath = defaultFactoryReporterConfigPath(env);
  const storePath = defaultRuntimeErrorStorePath(env);
  return { root, env, configPath, storePath };
}

function enableCollection(box, reporting = { enabled: false }) {
  mkdirSync(join(box.env.XDG_CONFIG_HOME, 'dotagents'), { recursive: true });
  writeFileSync(box.configPath, JSON.stringify({
    schema_version: '1.0',
    host: { id: 'test-host', profile: 'mac' },
    collection: { enabled: true },
    reporting,
  }));
}

test('runtime error store: missing/false/malformed config is fail-closed and creates no state', () => {
  for (const config of [
    null,
    { collection: { enabled: true } },
    { collection: { enabled: false } },
    { collection: { enabled: 'true' } },
    '{malformed',
  ]) {
    const box = sandbox();
    if (config !== null) {
      mkdirSync(join(box.env.XDG_CONFIG_HOME, 'dotagents'), { recursive: true });
      writeFileSync(box.configPath, typeof config === 'string' ? config : JSON.stringify(config));
    }
    assert.deepEqual(observeRuntimeError({ code: 'HOOK_PROCESS_TURN_FAILED' }, { env: box.env }), {
      status: 'disabled',
    });
    assert.equal(getRuntimeErrorDiagnostics({ env: box.env }).collection, 'disabled');
    assert.throws(() => statSync(box.storePath), { code: 'ENOENT' });
  }
});

test('runtime error store: Windows native uses the canonical LocalAppData paths', () => {
  const env = {
    OS: 'Windows_NT',
    USERPROFILE: 'C:\\Users\\kite_',
    LOCALAPPDATA: 'C:\\Users\\kite_\\AppData\\Local',
  };
  assert.equal(
    defaultFactoryReporterConfigPath(env),
    join(env.LOCALAPPDATA, 'dotagents', 'factory-reporter', 'config.json'),
  );
  assert.equal(
    defaultRuntimeErrorStorePath(env),
    join(env.LOCALAPPDATA, 'throughline', 'runtime-errors.json'),
  );
});

test('runtime error store: reporting config and credentials are ignored and no network API is accepted', () => {
  const box = sandbox();
  enableCollection(box, {
    enabled: true,
    endpoint: 'https://should-never-be-read.invalid/private',
    credential_file: '/private/token',
  });
  const result = observeRuntimeError(
    { code: 'HOOK_PROCESS_TURN_FAILED', now: '2026-07-13T00:00:00.000Z' },
    { env: box.env, version: '0.6.1', platform: 'darwin', arch: 'arm64' },
  );
  assert.equal(result.status, 'recorded');
  const bytes = readFileSync(box.storePath, 'utf8');
  assert.doesNotMatch(bytes, /should-never-be-read|private\/token|endpoint|credential/i);
});

test('runtime error store: observation API rejects raw or arbitrary fields', () => {
  const box = sandbox();
  enableCollection(box);
  for (const forbidden of [
    { exception: new Error('secret') },
    { stderr: 'raw stderr' },
    { stack: 'raw stack' },
    { prompt: 'private prompt' },
    { session: 'session-id' },
    { path: '/Users/private/file' },
    { context: { arbitrary: true } },
  ]) {
    assert.throws(
      () => observeRuntimeError({ code: 'HOOK_PROCESS_TURN_FAILED', ...forbidden }, { env: box.env }),
      /固定 code と時刻だけ/,
    );
  }
  assert.throws(
    () => observeRuntimeError(
      { code: 'HOOK_PROCESS_TURN_FAILED' },
      { env: box.env, stderr: 'raw stderr' },
    ),
    /未定義 option/,
  );
  assert.throws(
    () => observeRuntimeError({ code: 'UNKNOWN_FAILURE' }, { env: box.env }),
    /未登録の runtime error code/,
  );
  assert.throws(() => statSync(box.storePath), { code: 'ENOENT' });
});

test('runtime error store: fixed template SHA-256 fingerprint aggregates and reopens', () => {
  const box = sandbox();
  enableCollection(box);
  const options = { env: box.env, version: '0.6.1', platform: 'darwin', arch: 'arm64' };
  const first = observeRuntimeError(
    { code: 'HOOK_PROCESS_TURN_FAILED', now: '2026-07-13T00:00:00.000Z' }, options,
  );
  const second = observeRuntimeError(
    { code: 'HOOK_PROCESS_TURN_FAILED', now: '2026-07-13T00:01:00.000Z' }, options,
  );
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(second.fingerprint, first.fingerprint);

  let snapshot = readRuntimeErrorSnapshot({ env: box.env });
  assert.equal(snapshot.runtime_errors.length, 1);
  assert.deepEqual(snapshot.runtime_errors[0], {
    error_code: 'HOOK_PROCESS_TURN_FAILED',
    component: 'claude_stop_hook',
    status: 'open',
    severity: 'high',
    fingerprint: first.fingerprint,
    message_template: 'Throughline Claude Stop hook processing failed',
    occurrence_count: 2,
    first_seen: '2026-07-13T00:00:00.000Z',
    last_seen: '2026-07-13T00:01:00.000Z',
    state_schema_version: '1.0',
  });

  const resolved = resolveRuntimeError(first.fingerprint, {
    env: box.env,
    now: '2026-07-13T00:02:00.000Z',
  });
  assert.equal(resolved.status, 'resolved');
  snapshot = readRuntimeErrorSnapshot({ env: box.env });
  assert.equal(snapshot.runtime_errors.length, 0);
  assert.deepEqual(snapshot.resolutions, [{
    fingerprint: first.fingerprint,
    resolved_at: '2026-07-13T00:02:00.000Z',
    reason_code: 'manual',
  }]);
  assert.equal(reopenRuntimeError(first.fingerprint, { env: box.env }).status, 'open');
  assert.equal(readRuntimeErrorSnapshot({ env: box.env }).resolutions.length, 0);
  resolveRuntimeError(first.fingerprint, { env: box.env, now: '2026-07-13T00:02:30.000Z', reasonCode: 'recovered' });

  observeRuntimeError(
    { code: 'HOOK_PROCESS_TURN_FAILED', now: '2026-07-13T00:03:00.000Z' }, options,
  );
  snapshot = readRuntimeErrorSnapshot({ env: box.env });
  assert.equal(snapshot.runtime_errors[0].status, 'open');
  assert.equal(snapshot.runtime_errors[0].occurrence_count, 3);
  assert.equal(snapshot.runtime_errors[0].last_seen, '2026-07-13T00:03:00.000Z');
});

test('runtime error store: cursor/ack are monotonic and snapshots are bounded', () => {
  const box = sandbox();
  enableCollection(box);
  const options = { env: box.env, version: '0.6.1' };
  observeRuntimeError({ code: 'HOOK_PROCESS_TURN_FAILED', now: '2026-07-13T00:00:00.000Z' }, options);
  observeRuntimeError({ code: 'HOOK_SESSION_START_FAILED', now: '2026-07-13T00:01:00.000Z' }, options);
  observeRuntimeError({ code: 'HOOK_PROMPT_SUBMIT_FAILED', now: '2026-07-13T00:02:00.000Z' }, options);

  const page = readRuntimeErrorSnapshot({ env: box.env, afterCursor: 0, limit: 2 });
  assert.equal(page.runtime_errors.length, 2);
  assert.equal(page.diagnostics.truncated, true);
  assert.equal(page.cursor.high_watermark, 3);
  assert.equal(page.cursor.acknowledged_through, 0);
  assert.equal(acknowledgeRuntimeErrors(2, { env: box.env }).acknowledgedThrough, 2);
  assert.equal(acknowledgeRuntimeErrors(1, { env: box.env }).acknowledgedThrough, 2);
  assert.throws(() => acknowledgeRuntimeErrors(999, { env: box.env }), /high watermark/);
  assert.equal(readRuntimeErrorSnapshot({ env: box.env }).cursor.acknowledged_through, 2);
});

test('runtime error store: compact removes only acknowledged resolved expired records', () => {
  const box = sandbox();
  enableCollection(box);
  const options = { env: box.env, version: '0.6.1' };
  const old = observeRuntimeError(
    { code: 'HOOK_PROCESS_TURN_FAILED', now: '2026-06-01T00:00:00.000Z' }, options,
  );
  const pending = observeRuntimeError(
    { code: 'HOOK_SESSION_START_FAILED', now: '2026-06-01T00:00:00.000Z' }, options,
  );
  resolveRuntimeError(old.fingerprint, { env: box.env, now: '2026-06-02T00:00:00.000Z' });
  resolveRuntimeError(pending.fingerprint, { env: box.env, now: '2026-06-02T00:00:00.000Z' });
  acknowledgeRuntimeErrors(3, { env: box.env });

  const result = compactRuntimeErrors({
    env: box.env,
    now: '2026-07-13T00:00:00.000Z',
    retentionMs: 30 * 24 * 60 * 60 * 1000,
  });
  assert.equal(result.removed, 1);
  const snapshot = readRuntimeErrorSnapshot({ env: box.env });
  assert.equal(snapshot.runtime_errors.length, 0);
  assert.equal(snapshot.resolutions.length, 1);
  assert.equal(snapshot.resolutions[0].fingerprint, pending.fingerprint);
});

test('runtime error store: atomic private store has owner-only modes and bounded diagnostics', () => {
  const box = sandbox();
  enableCollection(box);
  observeRuntimeError({ code: 'HOOK_CODEX_FAILED' }, { env: box.env, version: '0.6.1' });
  assert.equal(statSync(join(box.env.XDG_STATE_HOME, 'throughline')).mode & 0o777, 0o700);
  assert.equal(statSync(box.storePath).mode & 0o777, 0o600);
  assert.doesNotThrow(() => JSON.parse(readFileSync(box.storePath, 'utf8')));

  const diagnostics = getRuntimeErrorDiagnostics({ env: box.env });
  assert.deepEqual(Object.keys(diagnostics).sort(), [
    'acknowledged_through', 'collection', 'high_watermark', 'open_count',
    'pending_count', 'schema', 'status', 'total_count',
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /Users|\\|\.throughline|runtime-errors\.json/);
});

test('runtime error store: non-canonical reporting values keep collection fail-closed', () => {
  const box = sandbox();
  enableCollection(box, { enabled: true, endpoint: 'ftp://invalid', credential_file: '' });
  assert.deepEqual(observeRuntimeError({ code: 'HOOK_CODEX_FAILED' }, { env: box.env }), { status: 'disabled' });
});

test('runtime error store: unknown top-level fields and future ack are rejected before compaction', () => {
  const box = sandbox();
  enableCollection(box);
  const captured = observeRuntimeError({ code: 'HOOK_CODEX_FAILED', now: '2026-06-01T00:00:00.000Z' }, { env: box.env });
  resolveRuntimeError(captured.fingerprint, { env: box.env, now: '2026-06-02T00:00:00.000Z' });
  const store = JSON.parse(readFileSync(box.storePath, 'utf8'));
  store.secret = '/Users/private Bearer secret-token';
  store.acknowledged_through = 999;
  writeFileSync(box.storePath, JSON.stringify(store), { mode: 0o600 });
  assert.equal(getRuntimeErrorDiagnostics({ env: box.env }).status, 'unavailable');
  assert.throws(() => compactRuntimeErrors({ env: box.env, now: '2026-07-13T00:00:00.000Z', retentionMs: 0 }));
});

test('runtime error store: mode drift is unavailable and a crashed SQLite lock owner is released by the OS', { skip: process.platform === 'win32' }, async () => {
  const box = sandbox();
  enableCollection(box);
  observeRuntimeError({ code: 'HOOK_CODEX_FAILED' }, { env: box.env });
  chmodSync(box.storePath, 0o644);
  assert.equal(getRuntimeErrorDiagnostics({ env: box.env }).status, 'unavailable');
  chmodSync(box.storePath, 0o600);
  const lockPath = `${box.storePath}.lock.sqlite`;
  const script = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(${JSON.stringify(lockPath)}); db.exec('BEGIN IMMEDIATE'); console.log('READY'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.once('data', (chunk) => String(chunk).includes('READY') ? resolve() : reject(new Error('lock fixture did not start')));
    child.once('error', reject);
  });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(observeRuntimeError({ code: 'HOOK_CODEX_FAILED' }, { env: box.env }).status, 'recorded');
});

test('runtime error store: atomic lock publication preserves all concurrent process observations', async () => {
  const box = sandbox();
  enableCollection(box);
  const modulePath = new URL('./runtime-error-store.mjs', import.meta.url).href;
  const script = `import {observeRuntimeError} from ${JSON.stringify(modulePath)}; observeRuntimeError({code:'HOOK_CODEX_FAILED'});`;
  const results = await Promise.all(Array.from({ length: 20 }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ...box.env }, stdio: 'ignore',
    });
    child.once('exit', (code) => resolve(code));
  })));
  assert.deepEqual(results, Array(20).fill(0));
  const snapshot = readRuntimeErrorSnapshot({ env: box.env });
  assert.equal(snapshot.runtime_errors[0].occurrence_count, 20);
});
