#!/usr/bin/env node
/**
 * UserPromptSubmit hook — L1+L2 の通常再注入
 *
 * ユーザーがメッセージを送るたびに呼ばれる。
 * SQLite から現プロジェクトの L1+L2 を読んで生テキストで stdout に出力する。
 *
 * 【/clear 後の引き継ぎは SessionStart hook 側で完了している前提】
 *   SessionStart が前任を張り替え、新セッション配下に L1/L2/L3 を寄せ集めている。
 *   本 hook は毎ターン「現セッション (= 合流先)」の最新状態を再注入するだけ。
 *
 * 【merge 追従】
 *   並行セッション A が B に合流された後に A から UserPromptSubmit が来る可能性があるため、
 *   resolveMergeTarget で合流先を解決してから SELECT する。
 *
 * stdout 形式（確認済み）: 生テキスト出力（JSON ラッパーなし）
 */

import { getDb } from './db.mjs';
import { resolveMergeTarget } from './session-merger.mjs';
import { buildResumeContext } from './resume-context.mjs';
import { writeSessionState } from './state-file.mjs';

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

  // token-monitor 向けにセッション単位の状態ファイルを更新
  if (payload.session_id) {
    writeSessionState({
      sessionId: payload.session_id,
      projectPath: payload.cwd ?? process.cwd(),
      transcriptPath: payload.transcript_path ?? null,
      pid: process.ppid, // hook は短命の子プロセス。親 = Claude Code プロセスを記録
    });
  }

  const db = getDb();

  // merge 追従: payload.session_id が既に合流されていたら合流先を使う
  const { target } = resolveMergeTarget(db, payload.session_id);

  const context = buildResumeContext(db, {
    sessionId: target,
    isInheritance: false,
  });

  if (context) {
    process.stdout.write(context + '\n');
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[context-injector] error: ${err.message}\n`);
  process.exit(1);
});
