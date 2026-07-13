import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { captureCodexRolloutToDb } from './codex-capture.mjs';
import { runCodexUserPromptSubmitHook } from './cli/codex-hook.mjs';
import { findCodexThreadCandidate } from './codex-thread-index.mjs';

const THREAD_ID = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';

function makeCaptureDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      merged_into TEXT
    );
    CREATE TABLE skeletons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE bodies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      token_count INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      origin_session_id TEXT,
      turn_number INTEGER,
      tool_name TEXT NOT NULL,
      input_text TEXT,
      output_text TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      kind TEXT,
      source_id TEXT
    );
  `);
  return db;
}

function event(type, payload = {}) {
  return {
    timestamp: '2026-07-13T00:00:00.000Z',
    type: 'event_msg',
    payload: { type, ...payload },
  };
}

function developerMemory(text = '## Throughline: Active Work Context\ninternal memory') {
  return {
    timestamp: '2026-07-13T00:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text }],
    },
  };
}

function toolInput() {
  return {
    timestamp: '2026-07-13T00:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      arguments: '{"cmd":"pwd"}',
      call_id: 'call_inflight',
    },
  };
}

function writeRollout(home, { cwd, id = THREAD_ID, events = [] }) {
  const dir = join(home, 'sessions', '2026', '07', '13');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-07-13T00-00-00-${id}.jsonl`);
  const rows = [
    {
      timestamp: '2026-07-13T00:00:00.000Z',
      type: 'session_meta',
      payload: { id, cwd, source: 'vscode', cli_version: '0.128.0-alpha.1' },
    },
    ...events,
  ];
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return path;
}

test('Phase 0: capture projection preserves one completed user/assistant pair and its Codex origin identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-phase0-capture-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-phase0-capture-project-'));
  const db = makeCaptureDb();
  try {
    writeRollout(home, {
      cwd: project,
      events: [
        event('user_message', { message: 'completed user request' }),
        event('task_started'),
        event('agent_message', { message: 'completed assistant response' }),
        event('task_complete'),
        developerMemory(),
      ],
    });

    const result = captureCodexRolloutToDb(db, { threadId: THREAD_ID, codexHome: home, projectPath: project });
    assert.equal(result.status, 'captured');
    assert.deepEqual(
      db
        .prepare('SELECT origin_session_id, turn_number, role, text FROM bodies ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [
        { origin_session_id: `codex:${THREAD_ID}`, turn_number: 1, role: 'user', text: 'completed user request' },
        {
          origin_session_id: `codex:${THREAD_ID}`,
          turn_number: 1,
          role: 'assistant',
          text: 'completed assistant response',
        },
      ],
      'audit projection candidates are completed conversation pairs only',
    );
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('Phase 0: read-only WAL audit harness sees committed data during a writer transaction without writing DB sidecars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-phase0-wal-'));
  const path = join(dir, 'throughline.db');
  const writer = new DatabaseSync(path);
  let reader;
  try {
    writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE audit_probe (value TEXT); INSERT INTO audit_probe VALUES (\'committed\');');
    writer.exec("BEGIN IMMEDIATE; UPDATE audit_probe SET value = 'uncommitted';");

    const before = snapshotSqliteFiles(path);
    reader = new DatabaseSync(path, { readOnly: true });
    assert.equal(reader.prepare('SELECT value FROM audit_probe').get().value, 'committed');
    assert.throws(() => reader.exec("INSERT INTO audit_probe VALUES ('forbidden')"));
    assert.deepEqual(snapshotSqliteFiles(path), before, 'audit reader must not modify DB, -wal, or -shm');
  } finally {
    reader?.close();
    writer.exec('ROLLBACK');
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase 0: Spotter child environment prevents Throughline Codex hook re-entry before any capture side effect', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-phase0-spotter-home-'));
  const project = mkdtempSync(join(tmpdir(), 'tl-phase0-spotter-project-'));
  try {
    writeRollout(home, {
      cwd: project,
      events: [
        event('user_message', { message: 'must not be captured from Spotter child' }),
        event('task_started'),
        event('agent_message', { message: 'must not be captured from Spotter child' }),
        event('task_complete'),
      ],
    });

    for (const childEnv of ['SPOTTER_PARENT_PID', 'SPOTTER_BACKEND', 'SPOTTER_CHILD_BACKEND']) {
      const db = makeCaptureDb();
      let monitorWrites = 0;
      let taskEnsures = 0;
      try {
        const result = await runCodexUserPromptSubmitHook({
          args: { codexThreadId: THREAD_ID, codexHome: home, projectPath: project },
          env: { [childEnv]: '1' },
          db,
          ensureMonitorTask: () => {
            taskEnsures++;
          },
          writeMonitorState: () => {
            monitorWrites++;
          },
          buildMonitorUsage: () => null,
        });

        assert.equal(result.status, 'skipped', childEnv);
        assert.equal(result.reason, 'spotter_child_backend', childEnv);
        assert.equal(taskEnsures, 0, childEnv);
        assert.equal(monitorWrites, 0, childEnv);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bodies').get().count, 0, childEnv);
      } finally {
        db.close();
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('Phase 0: project identity accepts a rollout under a marker root subdirectory through symlink and Windows-style case', () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-phase0-identity-home-'));
  const markerRoot = mkdtempSync(join(tmpdir(), 'tl-phase0-marker-root-'));
  const aliasParent = mkdtempSync(join(tmpdir(), 'tl-phase0-marker-alias-'));
  const child = join(markerRoot, 'packages', 'adapter');
  const alias = join(aliasParent, 'spotter-link');
  try {
    mkdirSync(child, { recursive: true });
    symlinkSync(markerRoot, alias);
    assert.ok(lstatSync(alias).isSymbolicLink());

    writeRollout(home, { cwd: child });
    assert.equal(
      findCodexThreadCandidate({ threadId: THREAD_ID, codexHome: home, projectPath: alias })?.id,
      THREAD_ID,
      'marker root must include rollout cwd descendants after symlink resolution',
    );

    const windowsThreadId = '019dfabb-1111-7111-8111-111111111111';
    writeRollout(home, {
      id: windowsThreadId,
      cwd: 'C:\\Users\\Kite\\Developer\\Spotter\\packages\\adapter',
    });
    assert.equal(
      findCodexThreadCandidate({
        threadId: windowsThreadId,
        codexHome: home,
        projectPath: 'c:/users/kite/developer/spotter',
      })?.id,
      windowsThreadId,
      'Windows-style path case must retain marker-root descendant identity',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(markerRoot, { recursive: true, force: true });
    rmSync(aliasParent, { recursive: true, force: true });
  }
});

function snapshotSqliteFiles(path) {
  return [path, `${path}-wal`, `${path}-shm`].map((file) => {
    if (!existsSync(file)) return { file, exists: false };
    const stat = lstatSync(file);
    try {
      return { file, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, bytes: readFileSync(file).toString('hex') };
    } catch (error) {
      if (error?.code === 'EBUSY') return { file, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, readError: 'EBUSY' };
      throw error;
    }
  });
}
