/**
 * state-file.mjs — セッション単位の状態ファイル管理（共有モジュール）
 *
 * パス: ~/.throughline/state/<session_id>.json
 * 書き手: turn-processor (Stop)
 * 読み手: token-monitor
 *
 * 設計判断 (docs/PUBLIC_RELEASE_PLAN.md §4.5/4.6):
 *   - ファイル単位分割で last-writer-wins 問題を解消
 *   - PID 生存チェックで stale 削除（時間窓は使わない）
 *   - projectPath は path.resolve → / → 末尾 / 除去 → Windows lowercase で正規化
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

const STATE_DIR = join(homedir(), '.throughline', 'state');

/** 状態ファイル保管ディレクトリを返す */
export function getStateDir() {
  return STATE_DIR;
}

/**
 * projectPath を正規化する（書き手/読み手で同じ関数を通すのが契約）
 * @param {string} p
 * @returns {string}
 */
export function normalizeProjectPath(p) {
  if (!p) return '';
  let result = resolve(p).replace(/\\/g, '/');
  if (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1);
  if (platform() === 'win32') result = result.toLowerCase();
  return result;
}

/**
 * セッション状態ファイルを書く
 * @param {{sessionId: string, projectPath: string, transcriptPath: string, pid: number}} data
 */
export function writeSessionState({ sessionId, projectPath, transcriptPath, pid }) {
  if (!sessionId) throw new Error('writeSessionState: sessionId is required');
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const file = join(STATE_DIR, `${sessionId}.json`);
  const payload = {
    sessionId,
    projectPath: normalizeProjectPath(projectPath),
    transcriptPath: transcriptPath ?? null,
    pid: pid ?? process.pid,
    updatedAt: Date.now(),
  };
  writeFileSync(file, JSON.stringify(payload));
}

// 活動タイムアウト（表示フィルタ / 削除）
// 背景: Windows + VSCode の hook process tree は `Claude Code → 短命 shell → node`
//       で process.ppid は即死する shell を指すため、PID 生存チェック案は機能しない。
//       代替として state ファイルの updatedAt を活動信号にする。
export const STALE_HIDE_MS = 15 * 60 * 1000;       // 15 分: 表示から隠す（次の発話で復活）
export const STALE_DELETE_MS = 24 * 60 * 60 * 1000; // 24 時間: ファイル自体を削除

/**
 * 全セッション状態を読む。24 時間超のファイルは削除、壊れたファイルも削除する。
 * 15 分超のファイルは「stale」フラグを付けて返す（monitor 側で隠す判断をする）。
 * @returns {Array<{sessionId: string, projectPath: string, transcriptPath: string|null, updatedAt: number, stale: boolean}>}
 */
export function readAllSessionStates() {
  if (!existsSync(STATE_DIR)) return [];
  const now = Date.now();
  let entries;
  try {
    entries = readdirSync(STATE_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    process.stderr.write(`[state-file] readdir failed (${err.code ?? 'unknown'}): ${err.message}\n`);
    return [];
  }
  const results = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = join(STATE_DIR, name);

    // 常駐 monitor を落とさないため IO 例外は吸収する。
    // ENOENT: 削除 race、EACCES/EPERM: 一時的権限問題、いずれも skip して次フレームで再試行
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        process.stderr.write(`[state-file] read failed ${name} (${err.code ?? 'unknown'}): ${err.message}\n`);
      }
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // JSON 破損は状態ファイル固有の冪等な状況（次ターンで再生成される）
      process.stderr.write(`[state-file] corrupt state file ${name}, deleting: ${err.message}\n`);
      try {
        unlinkSync(file);
      } catch {
        // 削除失敗も握りつぶす（次回削除される）
      }
      continue;
    }
    const age = now - (parsed.updatedAt ?? 0);
    if (age > STALE_DELETE_MS) {
      // 24h 超: ハード削除（無制限蓄積防止）
      try {
        unlinkSync(file);
      } catch {
        // 削除失敗は致命ではない、次回再試行
      }
      continue;
    }
    parsed.stale = age > STALE_HIDE_MS;
    results.push(parsed);
  }
  return results;
}

/**
 * ファイル単位の mtime スナップショットを取る（差分検知用）
 * @returns {Map<string, number>}
 */
export function snapshotStateMtimes() {
  const result = new Map();
  if (!existsSync(STATE_DIR)) return result;
  let entries;
  try {
    entries = readdirSync(STATE_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return result;
    process.stderr.write(`[state-file] snapshot readdir failed (${err.code ?? 'unknown'}): ${err.message}\n`);
    return result;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    // readdir と stat の間でファイルが削除される race がある。
    // monitor を落とさないため ENOENT 以外の IO 例外も吸収する（EACCES/EPERM 等は一時的で次フレームで回復）
    const file = join(STATE_DIR, name);
    try {
      result.set(name, statSync(file).mtimeMs);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        process.stderr.write(`[state-file] stat failed ${name} (${err.code ?? 'unknown'}): ${err.message}\n`);
      }
    }
  }
  return result;
}
