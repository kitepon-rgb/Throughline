import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BIN_PATH = join(REPO_ROOT, 'bin/throughline.mjs');
const EXPERIMENTAL_ENV = 'THROUGHLINE_EXPERIMENTAL_CODEX_ROLLBACK_MODEL_VISIBLE_SMOKE';

function makeFakeCodexAppServer(dir, mode) {
  const script = join(dir, `fake-codex-rollback-model-visible-${mode}.mjs`);
  const delta =
    mode === 'visible'
      ? 'TL_ROLLBACK_MODEL_VISIBLE_SECRET'
      : 'TL_ROLLBACK_MODEL_VISIBLE_NOT_VISIBLE';
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
let turns = [{ id: 'turn-1' }];
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialized') return;
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex' } });
  } else if (msg.method === 'thread/read' || msg.method === 'thread/resume') {
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns } } });
  } else if (msg.method === 'thread/rollback') {
    turns = turns.slice(0, Math.max(0, turns.length - msg.params.numTurns));
    send({ id: msg.id, result: { thread: { id: msg.params.threadId, turns } } });
  } else if (msg.method === 'turn/start') {
    const prompt = JSON.stringify(msg.params.input);
    if (prompt.includes('verification') && prompt.includes('TL_ROLLBACK_MODEL_VISIBLE_SECRET')) {
      send({ id: msg.id, error: { code: -32000, message: 'full marker leaked into verify prompt' } });
      return;
    }
    turns = [...turns, { id: 'turn-' + (turns.length + 1) }];
    if (prompt.includes('verification')) {
      send({ method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, turnId: 'turn-verify', itemId: 'item-1', delta: '${delta}' } });
    }
    send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn-current' } } });
    send({ id: msg.id, result: { turn: { id: 'turn-current' } } });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
`,
  );
  chmodSync(script, 0o755);
  return script;
}

function runSmoke(project, args = [], extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [BIN_PATH, 'codex-rollback-model-visible-smoke', ...args],
    {
      cwd: project,
      env: {
        ...process.env,
        ...extraEnv,
      },
      encoding: 'utf8',
    },
  );
}

test('codex-rollback-model-visible-smoke refuses without explicit experimental env', () => {
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-visible-cli-'));
  try {
    const result = runSmoke(project, [
      '--verify',
      '--codex-thread-id',
      'thread-rollback-visible',
      '--marker',
      'TL_ROLLBACK_MODEL_VISIBLE_SECRET',
      '--json',
    ]);

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'refused');
    assert.equal(payload.reason, 'experimental_env_required');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('codex-rollback-model-visible-smoke prepare starts and rolls back a marker turn', () => {
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-visible-cli-'));
  try {
    const fake = makeFakeCodexAppServer(project, 'hidden');
    const result = runSmoke(
      project,
      [
        '--prepare',
        '--codex-thread-id',
        'thread-rollback-visible',
        '--marker',
        'TL_ROLLBACK_MODEL_VISIBLE_SECRET',
        '--codex-app-server-bin',
        fake,
        '--json',
      ],
      { [EXPERIMENTAL_ENV]: '1' },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, 'prepare');
    assert.equal(payload.status, 'prepared');
    assert.equal(payload.rollbackSent, true);
    assert.match(payload.nextCommand, /codex-rollback-model-visible-smoke --verify/);
    assert.match(payload.nextCommand, /TL_ROLLBACK_MODEL_VISIBLE_SECRET/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('codex-rollback-model-visible-smoke marker-file keeps generated marker out of prepare output', () => {
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-visible-cli-'));
  try {
    const fake = makeFakeCodexAppServer(project, 'hidden');
    const markerFile = join(project, 'rollback-marker.json');
    const result = runSmoke(
      project,
      [
        '--prepare',
        '--codex-thread-id',
        'thread-rollback-visible',
        '--marker-file',
        markerFile,
        '--codex-app-server-bin',
        fake,
        '--json',
      ],
      { [EXPERIMENTAL_ENV]: '1' },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const markerPayload = JSON.parse(readFileSync(markerFile, 'utf8'));
    assert.equal(payload.status, 'prepared');
    assert.equal(payload.marker, '[redacted]');
    assert.equal(payload.markerRedacted, true);
    assert.equal(payload.markerFile, markerFile);
    assert.match(markerPayload.marker, /^TL_ROLLBACK_MODEL_VISIBLE_/);
    assert.doesNotMatch(result.stdout, new RegExp(markerPayload.marker));
    assert.match(payload.nextCommand, /--marker-file/);
    assert.doesNotMatch(payload.nextCommand, new RegExp(markerPayload.marker));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('codex-rollback-model-visible-smoke verify exits zero when marker is not reproduced', () => {
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-visible-cli-'));
  try {
    const fake = makeFakeCodexAppServer(project, 'hidden');
    const result = runSmoke(
      project,
      [
        '--verify',
        '--codex-thread-id',
        'thread-rollback-visible',
        '--marker',
        'TL_ROLLBACK_MODEL_VISIBLE_SECRET',
        '--codex-app-server-bin',
        fake,
        '--json',
      ],
      { [EXPERIMENTAL_ENV]: '1' },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, 'verify');
    assert.equal(payload.status, 'not-reproduced');
    assert.equal(payload.promptIncludesMarker, false);
    assert.equal(payload.rolledBackMarkerModelVisible, false);
    assert.equal(payload.modelReportedNotVisible, true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('codex-rollback-model-visible-smoke verify exits nonzero when marker is reproduced', () => {
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-visible-cli-'));
  try {
    const fake = makeFakeCodexAppServer(project, 'visible');
    const result = runSmoke(
      project,
      [
        '--verify',
        '--codex-thread-id',
        'thread-rollback-visible',
        '--marker',
        'TL_ROLLBACK_MODEL_VISIBLE_SECRET',
        '--codex-app-server-bin',
        fake,
        '--json',
      ],
      { [EXPERIMENTAL_ENV]: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, 'verify');
    assert.equal(payload.status, 'reproduced');
    assert.equal(payload.promptIncludesMarker, false);
    assert.equal(payload.rolledBackMarkerModelVisible, true);
    assert.equal(payload.modelReportedNotVisible, false);
    assert.deepEqual(payload.observedMarkers, ['TL_ROLLBACK_MODEL_VISIBLE_SECRET']);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('codex-rollback-model-visible-smoke marker-file redacts reproduced marker from verify output', () => {
  const project = mkdtempSync(join(tmpdir(), 'tl-codex-rollback-visible-cli-'));
  try {
    const fake = makeFakeCodexAppServer(project, 'visible');
    const markerFile = join(project, 'rollback-marker.json');
    writeFileSync(markerFile, JSON.stringify({ marker: 'TL_ROLLBACK_MODEL_VISIBLE_SECRET' }));
    const result = runSmoke(
      project,
      [
        '--verify',
        '--codex-thread-id',
        'thread-rollback-visible',
        '--marker-file',
        markerFile,
        '--codex-app-server-bin',
        fake,
        '--json',
      ],
      { [EXPERIMENTAL_ENV]: '1' },
    );

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'reproduced');
    assert.equal(payload.marker, '[redacted]');
    assert.equal(payload.markerRedacted, true);
    assert.deepEqual(payload.observedMarkers, ['[redacted]']);
    assert.doesNotMatch(result.stdout, /TL_ROLLBACK_MODEL_VISIBLE_SECRET/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
