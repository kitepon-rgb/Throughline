import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { decodeObserverCursor, encodeObserverCursor, resolveObserverTurnFeed } from './observer-turn-feed.mjs';
import { writeCompletedTurnReceipt } from './completed-turn-receipts.mjs';
import { hashAuditorBody } from './body-digest.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tl-observer-feed-'));
  const project = join(root, 'project'); const other = join(root, 'other'); const home = join(root, 'codex');
  mkdirSync(project); mkdirSync(other); mkdirSync(home);
  return { root, project, other, home, receiptOptions: { env: { HOME: root, USERPROFILE: root, XDG_STATE_HOME: join(root, 'state') } } };
}
function writeRollout(home, project, id, events) {
  const dir = join(home, 'sessions', '2026', '07', '15'); mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-07-15T00-00-00-${id}.jsonl`);
  const rows = [{ type: 'session_meta', timestamp: '2026-07-15T00:00:00.000Z', payload: { id, cwd: project } }, ...events];
  writeFileSync(path, rows.map(JSON.stringify).join('\n'));
  return path;
}
function event(type, message, timestamp) { return { type: 'event_msg', timestamp, payload: { type, ...(message === undefined ? {} : { message }) } }; }
function completeEvents(at = '2026-07-15T00:01:00.000Z') { return [event('user_message', 'request', '2026-07-15T00:00:01.000Z'), event('task_started', undefined, '2026-07-15T00:00:02.000Z'), event('agent_message', 'answer', '2026-07-15T00:00:03.000Z'), event('task_complete', undefined, at)]; }

test('observer feed: task_complete前とsynthetic continuationはchainを進めない', () => {
  const box = fixture();
  try {
    const id = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
    writeRollout(box.home, box.project, id, completeEvents().slice(0, 3));
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions }).chain.length, 0);
    writeRollout(box.home, box.project, id, [...completeEvents(), event('agent_message', 'continuation', '2026-07-15T00:01:01.000Z')]);
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions }).chain.length, 1);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('observer feed: same-thread append, rollback prefix change, and project separation', () => {
  const box = fixture();
  try {
    const id = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
    writeRollout(box.home, box.project, id, completeEvents());
    const first = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions });
    writeRollout(box.home, box.project, id, [...completeEvents(), ...completeEvents('2026-07-15T00:02:00.000Z')]);
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: first.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions }).status, 'append');
    writeRollout(box.home, box.project, id, [event('user_message', 'changed', '2026-07-15T00:00:01.000Z'), ...completeEvents().slice(1)]);
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: first.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions }).status, 'resync_required');
    const child = join(box.project, 'child'); mkdirSync(child);
    const childId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f7';
    writeRollout(box.home, child, childId, completeEvents('2026-07-15T00:03:00.000Z'));
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions }).chain.at(-1).completed_at, Date.parse('2026-07-15T00:03:00.000Z'), 'root配下cwdを含む');
    assert.equal(resolveObserverTurnFeed({ projectPath: box.other, codexHome: box.home, receiptOptions: box.receiptOptions }).chain.length, 0, '別projectは除外');
    assert.equal(resolveObserverTurnFeed({ projectPath: box.other, cursor: first.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions }).status, 'resync_required');
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('observer feed: Claude history floor, host/thread switch, cross-host tie, and opaque cursor', () => {
  const box = fixture();
  try {
    const options = box.receiptOptions;
    for (let i = 1; i <= 257; i++) writeCompletedTurnReceipt({ projectPath: box.project, targetSessionId: 'claude-session', originSessionId: `o${i}`, userBody: `u${i}`, assistantBody: `a${i}`, completedAt: i }, options);
    const latest = resolveObserverTurnFeed({ projectPath: box.project, receiptOptions: options, codexHome: box.home });
    const decoded = decodeObserverCursor(latest.throughCursor);
    const beforeFloor = encodeObserverCursor({ ...decoded, history_floor: 1 });
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: beforeFloor, receiptOptions: options, codexHome: box.home }).status, 'resync_required');
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: `${latest.throughCursor}x`, receiptOptions: options, codexHome: box.home }).status, 'resync_required');
    const oldVersion = `tlc1.${Buffer.from(JSON.stringify({ ...decoded, schema: 'throughline.observer_cursor.v0' })).toString('base64url')}`;
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: oldVersion, receiptOptions: options, codexHome: box.home }).status, 'resync_required');
    const changedPrefix = encodeObserverCursor({ ...decoded, prefix_sha256: 'f'.repeat(64) });
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: changedPrefix, receiptOptions: options, codexHome: box.home }).status, 'resync_required');
    assert.throws(() => encodeObserverCursor({ ...decoded, length: 0 }), /cursor invalid/);
    assert.doesNotMatch(JSON.stringify(decoded), new RegExp(`${box.project}|claude-session|u257|a257`));
    const id = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
    writeRollout(box.home, box.project, id, completeEvents('2026-07-15T00:03:00.000Z'));
    const switched = resolveObserverTurnFeed({ projectPath: box.project, cursor: latest.throughCursor, receiptOptions: options, codexHome: box.home });
    assert.equal(switched.status, 'host_switched');
    const secondId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f8';
    writeRollout(box.home, box.project, secondId, completeEvents('2026-07-15T00:04:00.000Z'));
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: switched.throughCursor, receiptOptions: options, codexHome: box.home }).status, 'thread_switched');
    writeCompletedTurnReceipt({ projectPath: box.project, targetSessionId: 'claude-tie', originSessionId: 'tie', userBody: 'tu', assistantBody: 'ta', completedAt: Date.parse('2026-07-15T00:03:00.000Z') }, options);
    // Tie the current Codex parent, not a stale earlier one.
    writeCompletedTurnReceipt({ projectPath: box.project, targetSessionId: 'claude-tie-current', originSessionId: 'tie-current', userBody: 'tuc', assistantBody: 'tac', completedAt: Date.parse('2026-07-15T00:04:00.000Z') }, options);
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, receiptOptions: options, codexHome: box.home }).status, 'ambiguous_parent');
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('observer feed: Codex pair hashes reuse DB capture role aggregation', () => {
  const box = fixture();
  try {
    const id = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
    writeRollout(box.home, box.project, id, [
      event('user_message', 'user one', '2026-07-15T00:00:01.000Z'),
      event('task_started', undefined, '2026-07-15T00:00:02.000Z'),
      event('user_message', 'user two', '2026-07-15T00:00:03.000Z'),
      event('agent_message', 'assistant one', '2026-07-15T00:00:04.000Z'),
      event('agent_message', 'assistant two', '2026-07-15T00:00:05.000Z'),
      event('task_complete', undefined, '2026-07-15T00:00:06.000Z'),
    ]);
    const result = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions });
    assert.equal(result.chain[0].user_sha256, hashAuditorBody('user one\n\nuser two'));
    assert.equal(result.chain[0].assistant_sha256, hashAuditorBody('assistant one\n\nassistant two'));
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('observer feed: prior source loss never downgrades into a switch', () => {
  const box = fixture();
  try {
    const primary = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
    const backup = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f8';
    const primaryPath = writeRollout(box.home, box.project, primary, completeEvents('2026-07-15T00:03:00.000Z'));
    writeRollout(box.home, box.project, backup, completeEvents('2026-07-15T00:02:00.000Z'));
    const prior = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions });
    rmSync(primaryPath);
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: prior.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions }).status, 'resync_required', 'old同hostへ露出してもswitchにしない');
    const backupPath = join(box.home, 'sessions', '2026', '07', '15', `rollout-2026-07-15T00-00-00-${backup}.jsonl`);
    writeCompletedTurnReceipt({ projectPath: box.project, targetSessionId: 'claude', originSessionId: 'origin', userBody: 'u', assistantBody: 'a', completedAt: Date.parse('2026-07-15T00:04:00.000Z') }, box.receiptOptions);
    rmSync(backupPath);
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: prior.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions }).status, 'resync_required', 'prior host消失で他hostが出てもresync');
    const claudePrior = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: box.receiptOptions });
    const receiptPath = join(box.root, 'state', 'throughline', 'completed-turn-receipts');
    rmSync(receiptPath, { recursive: true, force: true });
    assert.equal(resolveObserverTurnFeed({ projectPath: box.project, cursor: claudePrior.throughCursor, codexHome: box.home, receiptOptions: box.receiptOptions }).status, 'resync_required', 'source全消失もresync');
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test('observer feed: DB projection is all-or-nothing and never exposes raw session identity', () => {
  const box = fixture();
  const dbPath = join(box.root, 'throughline.db');
  let db;
  try {
    const options = box.receiptOptions;
    writeCompletedTurnReceipt({ projectPath: box.project, targetSessionId: 'private-session', originSessionId: 'private-origin', userBody: 'captured user', assistantBody: 'captured answer', completedAt: 1 }, options);
    const pending = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: options, dbPath });
    assert.equal(pending.status, 'projection_pending');
    assert.deepEqual(pending.turns, []);
    db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA user_version = 8;
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL);
      CREATE TABLE bodies (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, origin_session_id TEXT NOT NULL, turn_number INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    db.prepare('INSERT INTO sessions (session_id, project_path) VALUES (?, ?)').run('private-session', box.project);
    db.prepare('INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, 1, ?, ?, ?)').run('private-session', 'private-origin', 'user', 'captured user', 1);
    db.prepare('INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, 1, ?, ?, ?)').run('private-session', 'private-origin', 'assistant', 'captured answer', 2);
    const fresh = resolveObserverTurnFeed({ projectPath: box.project, codexHome: box.home, receiptOptions: options, dbPath, maxTotalChars: 0 });
    assert.equal(fresh.status, 'snapshot');
    assert.equal(fresh.turns.length, 1);
    assert.equal(fresh.turns[0].truncated, true);
    assert.doesNotMatch(JSON.stringify(fresh), /private-session|private-origin|captured user|captured answer/);
  } finally {
    db?.close();
    rmSync(box.root, { recursive: true, force: true });
  }
});
