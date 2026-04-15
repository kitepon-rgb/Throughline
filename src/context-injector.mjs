#!/usr/bin/env node
/**
 * UserPromptSubmit hook — 前任ターンの再注入（schema v4 新設計）
 *
 * ユーザーがメッセージを送るたびに呼ばれる。
 * 注入対象は「前任チェーンの過去ターンのみ」。現セッション内のターンは
 * Claude Code 本体のコンテキストに既に全文入っているので注入しない。
 *
 * 【/clear 後の引き継ぎは SessionStart hook 側で完了している前提】
 *   SessionStart が前任を張り替え、新セッション配下に bodies/skeletons/details を
 *   寄せ集めている。本 hook は毎ターン前任分を再注入するだけ。
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
  const { target, origin } = resolveMergeTarget(db, payload.session_id);

  // 現セッション origin のターンは既に Claude Code 本体のコンテキストにあるので除外
  const context = buildResumeContext(db, {
    sessionId: target,
    isInheritance: false,
    excludeOriginId: origin,
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
