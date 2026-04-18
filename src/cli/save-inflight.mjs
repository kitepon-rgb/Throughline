/**
 * throughline save-inflight — /tl 発動後、現行 Claude が中断地点の in-flight メモを
 * stdin 経由で書き込む CLI。
 *
 * 使い方 (Claude Code の Bash ツールから):
 *   throughline save-inflight <<'EOF'
 *   **次の一手**: ...
 *   **現在の方針**: ...
 *   **未解決の疑問**: ...
 *   **進行中 TODO**: ...
 *   EOF
 *
 * 動作:
 *   1. stdin を UTF-8 で全部読む
 *   2. 空なら exit 1 (§0 フォールバック禁止 — サイレント成功しない)
 *   3. cwd に対応する handoff_batons 行の memo_text を UPDATE
 *   4. バトン未登録なら updated=false で警告して exit 1
 *
 * 呼び出し元: [.claude/commands/tl.md] が Claude に実行させる
 */

import { getDb } from '../db.mjs';
import { updateBatonMemo } from '../baton.mjs';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function logInflight(entry) {
  const path = join(homedir(), '.throughline', 'logs', 'inflight-memo.log');
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[save-inflight:log] ${msg}\n`);
  }
}

export async function run() {
  let memoText;
  try {
    memoText = readFileSync(0, 'utf8').trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    process.stderr.write(`[save-inflight] failed to read stdin: ${msg}\n`);
    process.exit(1);
    return;
  }

  if (!memoText) {
    process.stderr.write(
      '[save-inflight] stdin was empty. Provide the in-flight memo via stdin (here-doc or pipe).\n',
    );
    process.exit(1);
    return;
  }

  const projectPath = process.cwd();
  const db = getDb();
  const { updated } = updateBatonMemo(db, { projectPath, memoText });

  logInflight({
    ts: new Date().toISOString(),
    project_path: projectPath,
    memo_length: memoText.length,
    baton_updated: updated,
  });

  if (!updated) {
    process.stderr.write(
      `[save-inflight] no baton found for ${projectPath}. ` +
        `Run /tl first so the baton exists, then save-inflight can attach the memo.\n`,
    );
    process.exit(1);
    return;
  }

  process.stdout.write(
    `[throughline] in-flight memo saved (${memoText.length} chars) for next session\n`,
  );
}
