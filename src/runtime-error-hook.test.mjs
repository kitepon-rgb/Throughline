import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultFactoryReporterConfigPath, defaultRuntimeErrorStorePath } from './runtime-error-store.mjs';
import { applyWindowsPrivateAcl } from './os/windows-acl-test-helper.mjs';

const BIN = fileURLToPath(new URL('../bin/throughline.mjs', import.meta.url));

function createEnabledEnvironment(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
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
  applyWindowsPrivateAcl(configPath);
  return { root, env };
}

test('top-level hook owners record one fixed aggregate per failure without replacing hook failure', () => {
  const { env } = createEnabledEnvironment('throughline-runtime-hook-');
  const cases = [
    ['session-start'],
    ['prompt-submit'],
    ['process-turn'],
    ['codex-hook', 'stop'],
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [BIN, ...args], {
      env,
      input: '{invalid-json',
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, args.join(' '));
    assert.notEqual(result.stderr, '', args.join(' '));
    assert.doesNotMatch(result.stderr, /store_unavailable/);
  }

  const storePath = defaultRuntimeErrorStorePath(env);
  let store = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(store.records.length, 4);
  assert.deepEqual(store.records.map((record) => record.error_code).sort(), [
    'HOOK_CODEX_FAILED',
    'HOOK_PROCESS_TURN_FAILED',
    'HOOK_PROMPT_SUBMIT_FAILED',
    'HOOK_SESSION_START_FAILED',
  ]);
  assert.ok(store.records.every((record) => record.count === 1));

  spawnSync(process.execPath, [BIN, 'process-turn'], {
    env,
    input: '{invalid-json',
    encoding: 'utf8',
  });
  store = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(store.records.find((record) => record.error_code === 'HOOK_PROCESS_TURN_FAILED').count, 2);
});

test('store failure preserves product failure and emits only fixed storage diagnostic', () => {
  const { env } = createEnabledEnvironment('throughline-runtime-hook-store-fail-');
  const storePath = defaultRuntimeErrorStorePath(env);
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, '{broken');

  const result = spawnSync(process.execPath, [BIN, 'prompt-submit'], {
    env,
    input: '{invalid-json',
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /store_unavailable/);
  assert.match(result.stderr, /SyntaxError|JSON/);
  assert.doesNotMatch(result.stderr, /runtime error store schema invalid/);
});

test('FIFO config cannot block the original hook failure', { skip: process.platform === 'win32' }, () => {
  const { env } = createEnabledEnvironment('throughline-runtime-hook-fifo-');
  const config = defaultFactoryReporterConfigPath(env);
  execFileSync('rm', ['-f', config]);
  execFileSync('mkfifo', [config]);
  const started = Date.now();
  const result = spawnSync(process.execPath, [BIN, 'prompt-submit'], {
    env,
    input: '{invalid-json',
    encoding: 'utf8',
    timeout: 2_000,
  });
  assert.notEqual(result.status, 0);
  assert(Date.now() - started < 1_500);
  assert.match(result.stderr, /SyntaxError|JSON/);
});
