/**
 * SQLite 接続管理 — node:sqlite (Node.js v22.5+ 組み込み、依存ゼロ)
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DB_DIR = join(homedir(), '.throughline');
const DB_PATH = join(DB_DIR, 'throughline.db');
const CURRENT_VERSION = 4;

let _db = null;

function initSchema(db) {
  const row = db.prepare('PRAGMA user_version').get();
  const version = row.user_version ?? 0;

  // v0 → v1: 全テーブル作成
  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id   TEXT    PRIMARY KEY,
        project_path TEXT    NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'active',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skeletons (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT    NOT NULL,
        turn_number  INTEGER NOT NULL,
        role         TEXT    NOT NULL,
        summary      TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS judgments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT    NOT NULL,
        turn_number  INTEGER NOT NULL,
        category     TEXT    NOT NULL,
        content      TEXT    NOT NULL,
        content_hash TEXT    NOT NULL,
        resolved     INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS details (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT    NOT NULL,
        turn_number  INTEGER,
        tool_name    TEXT    NOT NULL,
        input_text   TEXT,
        output_text  TEXT,
        token_count  INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS injection_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     TEXT    NOT NULL,
        event_type     TEXT    NOT NULL,
        turns_injected INTEGER NOT NULL DEFAULT 0,
        tokens_saved   INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL
      );
    `);
  }

  // v1 → v2: 重複排除用 UNIQUE インデックス追加
  if (version < 2) {
    // 先に既存の重複行を削除してからインデックスを作成
    db.exec(`
      DELETE FROM skeletons WHERE id NOT IN (
        SELECT MIN(id) FROM skeletons GROUP BY session_id, turn_number, role
      );
      DELETE FROM judgments WHERE id NOT IN (
        SELECT MIN(id) FROM judgments GROUP BY session_id, content_hash
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_skeletons_turn
        ON skeletons(session_id, turn_number, role);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_judgments_hash
        ON judgments(session_id, content_hash);
    `);
  }

  // v2 → v3: 記憶張り替え方式のための origin_session_id / merged_into 列追加
  if (version < 3) {
    // origin_session_id 列追加（デフォルト NULL、後続 UPDATE で自身の session_id をセット）
    const skeletonCols = db.prepare('PRAGMA table_info(skeletons)').all();
    if (!skeletonCols.some((c) => c.name === 'origin_session_id')) {
      db.exec('ALTER TABLE skeletons ADD COLUMN origin_session_id TEXT');
    }
    const judgmentCols = db.prepare('PRAGMA table_info(judgments)').all();
    if (!judgmentCols.some((c) => c.name === 'origin_session_id')) {
      db.exec('ALTER TABLE judgments ADD COLUMN origin_session_id TEXT');
    }
    const detailCols = db.prepare('PRAGMA table_info(details)').all();
    if (!detailCols.some((c) => c.name === 'origin_session_id')) {
      db.exec('ALTER TABLE details ADD COLUMN origin_session_id TEXT');
    }
    const sessionCols = db.prepare('PRAGMA table_info(sessions)').all();
    if (!sessionCols.some((c) => c.name === 'merged_into')) {
      db.exec('ALTER TABLE sessions ADD COLUMN merged_into TEXT');
    }

    // 既存行の origin_session_id に自身の session_id をセット
    db.exec(`
      UPDATE skeletons SET origin_session_id = session_id WHERE origin_session_id IS NULL;
      UPDATE judgments SET origin_session_id = session_id WHERE origin_session_id IS NULL;
      UPDATE details   SET origin_session_id = session_id WHERE origin_session_id IS NULL;
    `);

    // 旧 UNIQUE インデックス drop + 新 UNIQUE インデックス作成（origin_session_id を含む）
    db.exec(`
      DROP INDEX IF EXISTS uq_skeletons_turn;
      DROP INDEX IF EXISTS uq_judgments_hash;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_skeletons_turn_v3
        ON skeletons(session_id, origin_session_id, turn_number, role);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_judgments_hash_v3
        ON judgments(session_id, origin_session_id, content_hash);
      CREATE INDEX IF NOT EXISTS idx_skeletons_session
        ON skeletons(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_judgments_session
        ON judgments(session_id, resolved, created_at);
    `);
  }

  // v3 → v4: bodies テーブル追加（L2 = 会話自然言語ロスレス保存）、judgments DROP
  if (version < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bodies (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id        TEXT    NOT NULL,
        origin_session_id TEXT    NOT NULL,
        turn_number       INTEGER NOT NULL,
        role              TEXT    NOT NULL,
        text              TEXT    NOT NULL,
        token_count       INTEGER,
        created_at        INTEGER NOT NULL,
        UNIQUE(session_id, origin_session_id, turn_number, role)
      );
      CREATE INDEX IF NOT EXISTS idx_bodies_session_created
        ON bodies(session_id, created_at);
    `);

    // judgments テーブルと関連インデックスを DROP
    db.exec(`
      DROP INDEX IF EXISTS uq_judgments_hash_v3;
      DROP INDEX IF EXISTS uq_judgments_hash;
      DROP INDEX IF EXISTS idx_judgments_session;
      DROP TABLE IF EXISTS judgments;
    `);
  }

  if (version < CURRENT_VERSION) {
    db.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
  }
}

/**
 * DB インスタンスを返す（シングルトン）
 * @returns {DatabaseSync}
 */
export function getDb() {
  if (_db) return _db;

  mkdirSync(DB_DIR, { recursive: true });

  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');

  initSchema(_db);

  return _db;
}
