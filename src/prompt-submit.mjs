#!/usr/bin/env node
/**
 * UserPromptSubmit hook — /tl スラッシュコマンド検出 + バトン書き込み
 *
 * stdin: { session_id, cwd, prompt, hook_event_name, ... }
 *
 * 動作:
 *   - prompt が /tl (単独 or /tl ... 形式) で始まっていればバトンを書き込んで終了
 *   - それ以外は何もせず exit 0（プロンプトはそのまま Claude に渡る）
 *   - 本 hook は注入を一切行わない (SessionStart の引き継ぎ注入と二重にならないため)
 *
 * 設計背景: docs/INHERITANCE_ON_CLEAR_ONLY.md バトン方式
 */

import { getDb } from './db.mjs';
import { writeBaton } from './baton.mjs';
import { ensureMonitorTaskFile } from './vscode-task.mjs';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function logBaton(entry) {
  const path = join(homedir(), '.throughline', 'logs', 'baton-write.log');
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[prompt-submit:log] ${msg}\n`);
  }
}

/**
 * プロンプトが /tl バトン発動コマンドか判定する。
 * 許容: "/tl", "/tl\n", "/tl 何か" (前後空白は trim 済み前提)
 */
export function isBatonCommand(prompt) {
  if (typeof prompt !== 'string') return false;
  const trimmed = prompt.trim();
  if (trimmed === '/tl') return true;
  if (trimmed.startsWith('/tl ') || trimmed.startsWith('/tl\n')) return true;
  return false;
}

async function main() {
  let raw = '';
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', resolve);
  });

  const payload = JSON.parse(raw);
  const { session_id, cwd, prompt } = payload;

  // VSCode 新規プロジェクトへの tasks.json 自動プロビジョニング。
  // SessionStart/Stop に加えここでも呼ぶことで、どれか 1 つでも発火すれば初回メッセージ送信で
  // tasks.json が生える。冪等性は ensureMonitorTaskFile 側で保証。/tl 判定より前に置く。
  try {
    ensureMonitorTaskFile({ cwd: cwd ?? process.cwd(), env: process.env });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[vscode-task] ${msg}\n`);
  }

  if (!isBatonCommand(prompt)) {
    process.exit(0);
    return;
  }

  if (!session_id) {
    process.stderr.write('[prompt-submit] missing session_id in payload\n');
    process.exit(0);
    return;
  }

  const projectPath = cwd ?? process.cwd();
  const db = getDb();
  const now = Date.now();

  writeBaton(db, { projectPath, sessionId: session_id, now });

  logBaton({
    ts: new Date(now).toISOString(),
    session_id,
    project_path: projectPath,
  });

  process.exit(0);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : 'unknown';
  process.stderr.write(`[prompt-submit] error: ${msg}\n`);
  process.exit(1);
});
