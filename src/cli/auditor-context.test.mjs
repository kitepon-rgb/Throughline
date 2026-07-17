import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { AUDITOR_CONTEXT_SCHEMA, hashAuditorBody } from '../auditor-context.mjs';
import { run } from './auditor-context.mjs';

const REPO_ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const BIN_PATH = join(REPO_ROOT, 'bin/throughline.mjs');
const USER = 'auditor user body';
const ASSISTANT = 'auditor assistant body';

function makeDb({ originSessionId = 'origin-1' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-auditor-cli-'));
  const path = join(dir, 'throughline.db');
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA user_version = 9;
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL);
    CREATE TABLE bodies (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, origin_session_id TEXT NOT NULL, turn_number INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO sessions VALUES ('session-1', '/repo');
    INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES ('session-1', '${originSessionId}', 3, 'user', '${USER}', 1);
    INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES ('session-1', '${originSessionId}', 3, 'assistant', '${ASSISTANT}', 2);
  `);
  db.close();
  return { dir, path };
}

function args(path) {
  return [
    'auditor-context', '--session', 'session-1', '--project', '/repo', '--expected-origin-session', 'origin-1',
    '--expected-turn-number', '3', '--expected-user-sha256', hashAuditorBody(USER),
    '--expected-assistant-sha256', hashAuditorBody(ASSISTANT), '--db', path, '--json',
  ];
}

test('auditor-context CLI prints only fresh JSON to stdout', () => {
  const { dir, path } = makeDb();
  try {
    const result = spawnSync(process.execPath, [BIN_PATH, ...args(path)], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.schema, AUDITOR_CONTEXT_SCHEMA);
    assert.equal(output.status, 'fresh');
    assert.equal(output.turns[0].user, USER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auditor-context CLI transcript freshness mode derives a fresh Claude pair', () => {
  const { dir, path } = makeDb({ originSessionId: 'session-1' });
  const transcript = join(dir, 'claude.jsonl');
  try {
    writeFileSync(transcript, [
      claudeRow('user', 'earlier request'),
      claudeRow('assistant', 'earlier answer'),
      claudeRow('user', USER),
      claudeRow('assistant', ASSISTANT),
    ].map(JSON.stringify).join('\n'));
    const result = spawnSync(process.execPath, [
      BIN_PATH, 'auditor-context', '--session', 'session-1', '--project', '/repo', '--host', 'claude',
      '--transcript', transcript, '--db', path, '--json',
    ], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).status, 'fresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auditor-context CLI rejects mixed and partial freshness sources with the fixed args error', () => {
  const transcript = '/tmp/auditor-context-transcript.jsonl';
  const base = ['--session', 's', '--project', '/p', '--json'];
  const explicit = [
    '--expected-origin-session', 'origin', '--expected-turn-number', '1',
    '--expected-user-sha256', 'a'.repeat(64), '--expected-assistant-sha256', 'b'.repeat(64),
  ];
  const transcriptSource = ['--host', 'claude', '--transcript', transcript];
  for (const argv of [
    [...base, ...explicit, ...transcriptSource],
    [...base, '--host', 'claude'],
    [...base, '--transcript', transcript],
    [...base, '--expected-origin-session', 'origin'],
  ]) {
    const stderr = { text: '', write(value) { this.text += value; } };
    const stdout = { text: '', write(value) { this.text += value; } };
    assert.equal(run(argv, { stdout, stderr }), 1);
    assert.equal(stdout.text, '');
    assert.deepEqual(JSON.parse(stderr.text), {
      schema: AUDITOR_CONTEXT_SCHEMA, status: 'error', code: 'E_AUDITOR_CONTEXT_ARGS', message: 'invalid auditor-context arguments',
    });
  }
});

test('auditor-context CLI transcript parse failures use fixed JSON without leaking transcript path or body', () => {
  const transcript = '/private/path/with-secret-body.jsonl';
  const stderr = { text: '', write(value) { this.text += value; } };
  const stdout = { text: '', write(value) { this.text += value; } };
  const argv = ['--session', 's', '--project', '/p', '--host', 'codex', '--transcript', transcript, '--json'];
  assert.equal(run(argv, {
    deriveExpectation: () => { throw new Error(`parse failure ${transcript} ${USER}`); },
    stdout,
    stderr,
  }), 1);
  assert.equal(stdout.text, '');
  assert.deepEqual(JSON.parse(stderr.text), {
    schema: AUDITOR_CONTEXT_SCHEMA, status: 'error', code: 'E_AUDITOR_CONTEXT_INTERNAL', message: 'auditor context could not be read',
  });
  assert.doesNotMatch(stderr.text, /private|secret|auditor user|jsonl/i);
});

test('auditor-context CLI returns fixed JSON errors without raw body, hash, DB, or thrown error text', () => {
  const stderr = { text: '', write(value) { this.text += value; } };
  const stdout = { text: '', write(value) { this.text += value; } };
  assert.equal(run(['--session', 'only'], { stdout, stderr }), 1);
  assert.equal(stdout.text, '');
  assert.deepEqual(JSON.parse(stderr.text), {
    schema: AUDITOR_CONTEXT_SCHEMA, status: 'error', code: 'E_AUDITOR_CONTEXT_ARGS', message: 'invalid auditor-context arguments',
  });

  stderr.text = '';
  assert.equal(run(['--session', 's', '--project', '/p', '--expected-origin-session', 'o', '--expected-turn-number', '1', '--expected-user-sha256', 'a'.repeat(64), '--expected-assistant-sha256', 'b'.repeat(64), '--json'], {
    read: () => { throw new Error(`private ${USER} ${hashAuditorBody(USER)} /secret.db`); }, stdout, stderr,
  }), 1);
  assert.deepEqual(JSON.parse(stderr.text), {
    schema: AUDITOR_CONTEXT_SCHEMA, status: 'error', code: 'E_AUDITOR_CONTEXT_INTERNAL', message: 'auditor context could not be read',
  });
  assert.doesNotMatch(stderr.text, /private|secret|auditor user|[a-f0-9]{64}/i);
});

test('auditor-context bin dispatch and help advertise the JSON-only command', () => {
  const help = spawnSync(process.execPath, [BIN_PATH, '--help'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /throughline auditor-context --session <id> --project <root>/);
  assert.match(help.stdout, /always requires --json/);
});

function claudeRow(role, text) {
  return { type: role, message: { role, content: [{ type: 'text', text }] } };
}
