import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { findLatestSession, parseArgs, run } from './latest-session.mjs';

function output() {
  let value = '';
  return {
    stream: { write(chunk) { value += chunk; } },
    read() { return value; },
  };
}

test('project pathを絶対化して受け取る', () => {
  assert.equal(parseArgs(['--project', '.', '--json']).projectPath, process.cwd());
  assert.throws(() => parseArgs(['--project', '.']));
});

test('同じprojectの最新sessionだけを返す', () => {
  const root = mkdtempSync(join(tmpdir(), 'throughline-latest-session-'));
  const dbPath = join(root, 'throughline.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (session_id TEXT, project_path TEXT, updated_at TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('other-new', join(root, 'other'), '2026-09-01T03:00:00Z');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('same-old', join(root, 'bot'), '2026-09-01T01:00:00Z');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('same-new', join(root, 'bot'), '2026-09-01T02:00:00Z');
  db.close();

  try {
    assert.equal(findLatestSession(join(root, 'bot'), { dbPath }).session_id, 'same-new');
    assert.equal(findLatestSession(join(root, 'missing'), { dbPath }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readyとemptyをJSONで返す', () => {
  const stdout = output();
  const stderr = output();
  assert.equal(run(['--project', '/bots/a', '--json'], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    lookup: () => ({ session_id: 'claude:abc', updated_at: 'now' }),
  }), 0);
  assert.deepEqual(JSON.parse(stdout.read()), {
    schema: 'throughline.latest_session.v1',
    status: 'ready',
    projectPath: '/bots/a',
    sessionId: 'claude:abc',
    updatedAt: 'now',
  });

  const empty = output();
  assert.equal(run(['--project', '/bots/b', '--json'], {
    stdout: empty.stream,
    stderr: stderr.stream,
    lookup: () => null,
  }), 0);
  assert.equal(JSON.parse(empty.read()).status, 'empty');
});
