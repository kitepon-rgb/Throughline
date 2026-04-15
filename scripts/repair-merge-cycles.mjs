#!/usr/bin/env node
/**
 * repair-merge-cycles.mjs — sessions.merged_into のサイクルを検出・修復する one-off スクリプト
 *
 * 動作:
 *   1. merged_into チェーンを全セッションについて辿り、サイクルを構成するノード集合を検出
 *   2. 各サイクルについて、同プロジェクトの最新非合流セッション (liveTarget) を決定
 *   3. サイクル内の全 skeletons/judgments/details の session_id を liveTarget に付け替え
 *   4. サイクル内の全セッションの merged_into = liveTarget に設定
 *
 * --dry-run で差分のみ表示。
 */

import { getDb } from '../src/db.mjs';

const dryRun = process.argv.includes('--dry-run');

function detectCycles(db) {
  const rows = db.prepare('SELECT session_id, merged_into, project_path FROM sessions').all();
  const map = new Map(rows.map((r) => [r.session_id, r]));
  const cycles = new Map();

  for (const start of rows) {
    if (start.merged_into === null) continue;

    const visited = [];
    const seen = new Set();
    let current = start.session_id;

    while (current !== null && current !== undefined) {
      if (seen.has(current)) {
        const cycleStart = visited.indexOf(current);
        const cycleMembers = visited.slice(cycleStart).sort();
        const key = cycleMembers.join('|');
        if (!cycles.has(key)) {
          cycles.set(key, { members: cycleMembers, projectPath: map.get(current)?.project_path });
        }
        break;
      }
      seen.add(current);
      visited.push(current);
      const row = map.get(current);
      if (!row) break;
      current = row.merged_into;
    }
  }

  return [...cycles.values()];
}

function findLiveTarget(db, projectPath, cycleMembers) {
  const row = db
    .prepare(
      `SELECT session_id FROM sessions
       WHERE lower(project_path) = lower(?)
         AND merged_into IS NULL
         AND session_id NOT IN (${cycleMembers.map(() => '?').join(',')})
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(projectPath, ...cycleMembers);
  return row?.session_id ?? null;
}

function main() {
  const db = getDb();
  const cycles = detectCycles(db);

  if (cycles.length === 0) {
    process.stderr.write('[repair] no cycles detected.\n');
    return;
  }

  process.stderr.write(`[repair] detected ${cycles.length} cycle(s):\n`);

  for (const cycle of cycles) {
    const { members, projectPath } = cycle;
    const liveTarget = findLiveTarget(db, projectPath, members);

    process.stderr.write(
      `  cycle [${members.join(' -> ')}] in ${projectPath} => target ${liveTarget}\n`,
    );

    if (!liveTarget) {
      process.stderr.write(`    SKIP: no live target found for project ${projectPath}\n`);
      continue;
    }

    if (dryRun) {
      for (const m of members) {
        const sk = db.prepare('SELECT COUNT(*) c FROM skeletons WHERE session_id = ?').get(m).c;
        const jg = db.prepare('SELECT COUNT(*) c FROM judgments WHERE session_id = ?').get(m).c;
        const dt = db.prepare('SELECT COUNT(*) c FROM details   WHERE session_id = ?').get(m).c;
        process.stderr.write(`    ${m}: sk=${sk} jg=${jg} dt=${dt}\n`);
      }
      continue;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const placeholders = members.map(() => '?').join(',');
      const sk = db
        .prepare(`UPDATE skeletons SET session_id = ? WHERE session_id IN (${placeholders})`)
        .run(liveTarget, ...members);
      const jg = db
        .prepare(`UPDATE judgments SET session_id = ? WHERE session_id IN (${placeholders})`)
        .run(liveTarget, ...members);
      const dt = db
        .prepare(`UPDATE details   SET session_id = ? WHERE session_id IN (${placeholders})`)
        .run(liveTarget, ...members);

      db.prepare(`UPDATE sessions SET merged_into = ? WHERE session_id IN (${placeholders})`).run(
        liveTarget,
        ...members,
      );

      db.exec('COMMIT');
      process.stderr.write(
        `    REPAIRED: moved sk=${sk.changes} jg=${jg.changes} dt=${dt.changes} rows -> ${liveTarget}\n`,
      );
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }
  }
}

main();
