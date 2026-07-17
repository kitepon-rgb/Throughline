// 一時診断 (v0.7.0 release blocker 調査用 — 特定後に削除する):
// windows-latest でのみ再現する observer 系の
// 'auditor context DB project does not match' の比較対象値を CI ログへ出す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveObserverTurnFeed } from './observer-turn-feed.mjs';

// auditor-context.mjs の canonicalProjectPath の複製 (非export のため)
function auditorCanonical(raw) {
  let normalized = isAbsolute(raw) ? raw : resolve(raw);
  try {
    if (existsSync(normalized)) normalized = realpathSync.native(normalized);
  } catch {
    // keep lexical
  }
  return normalized.split(sep).join('/').replace(/\/+$/, '');
}
function auditorCompare(candidate, root) {
  const nc = auditorCanonical(candidate);
  const nr = auditorCanonical(root);
  const left = /^[A-Za-z]:\//.test(nc) ? nc.toLowerCase() : nc;
  const right = /^[A-Za-z]:\//.test(nr) ? nr.toLowerCase() : nr;
  return { left, right, match: left === right || left.startsWith(`${right}/`) };
}

test('DIAG: windows path canonicalization operands', () => {
  const root = mkdtempSync(join(tmpdir(), 'tl-win-diag-'));
  const project = join(root, 'project');
  const codexHome = join(root, 'codex-home');
  mkdirSync(project);
  mkdirSync(join(codexHome, 'sessions', '2026', '07', '15'), { recursive: true });
  const dbPath = join(root, 'throughline.db');
  try {
    console.error('[DIAG] tmpdir()          =', tmpdir());
    console.error('[DIAG] raw project       =', project);
    console.error('[DIAG] realpath.native   =', realpathSync.native(project));
    console.error('[DIAG] auditorCanonical  =', auditorCanonical(project));

    const threadId = '019dfaba-f87e-7f41-a144-d5ca7c6dd7f9';
    const rollout = join(codexHome, 'sessions', '2026', '07', '15', `rollout-2026-07-15T00-00-00-${threadId}.jsonl`);
    writeFileSync(rollout, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-07-15T00:00:00.000Z', payload: { id: threadId, cwd: project } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-15T00:00:01.000Z', payload: { type: 'user_message', message: 'hello' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-15T00:00:02.000Z', payload: { type: 'agent_message', message: 'world' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-15T00:00:03.000Z', payload: { type: 'task_complete', last_agent_message: 'world' } }),
    ].join('\n') + '\n', 'utf8');

    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA user_version = 9;
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL);
      CREATE TABLE bodies (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        origin_session_id TEXT NOT NULL, turn_number INTEGER NOT NULL,
        role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run(`codex:${threadId}`, project);
    db.prepare("INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, 1, 'user', 'hello', 1)").run(`codex:${threadId}`, `codex:${threadId}`);
    db.prepare("INSERT INTO bodies (session_id, origin_session_id, turn_number, role, text, created_at) VALUES (?, ?, 1, 'assistant', 'world', 2)").run(`codex:${threadId}`, `codex:${threadId}`);
    db.close();

    const cmp = auditorCompare(project, realpathSync.native(project));
    console.error('[DIAG] compare(dbRaw, realpathRoot):', JSON.stringify(cmp));

    let feedError = null;
    let result = null;
    try {
      result = resolveObserverTurnFeed({ projectPath: project, codexHome, dbPath });
    } catch (err) {
      feedError = err;
    }
    console.error('[DIAG] feed result status =', result?.status ?? null);
    console.error('[DIAG] feed error         =', feedError ? `${feedError.name}: ${feedError.message}` : null);
    if (result) {
      console.error('[DIAG] feed keys =', Object.keys(result).join(','));
    }
    // 常に成功させる (診断が目的。判定は人間が CI ログで行う)
    assert.ok(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
