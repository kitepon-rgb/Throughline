/**
 * throughline status — DB 統計表示
 */

import { getDb } from '../db.mjs';

export async function run() {
  const db = getDb();

  const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get();
  const skeletons = db.prepare('SELECT COUNT(*) as count FROM skeletons').get();
  let bodies = { count: 0 };
  try {
    bodies = db.prepare('SELECT COUNT(*) as count FROM bodies').get();
  } catch {
    // bodies テーブルは schema v4 以降。v3 DB では存在しない
  }
  const details = db.prepare('SELECT COUNT(*) as count FROM details').get();

  const recentSessions = db.prepare(`
    SELECT session_id, project_path, updated_at
    FROM sessions
    ORDER BY updated_at DESC
    LIMIT 5
  `).all();

  console.log('throughline status\n');
  console.log(`  sessions  : ${sessions.count}`);
  console.log(`  skeletons : ${skeletons.count} (L1)`);
  console.log(`  bodies    : ${bodies.count} (L2)`);
  console.log(`  details   : ${details.count} (L3)`);
  console.log('');
  console.log('最近のセッション:');
  for (const s of recentSessions) {
    const date = new Date(s.updated_at).toLocaleString('ja-JP');
    const shortId = s.session_id.slice(0, 8);
    const project = s.project_path.split(/[/\\]/).pop();
    console.log(`  ${shortId}  ${project}  ${date}`);
  }
  console.log('');
}
