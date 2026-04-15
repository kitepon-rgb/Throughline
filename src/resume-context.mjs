/**
 * resume-context.mjs — L1+L2 の再注入テキストを組み立てる共有モジュール
 *
 * 呼び出し元:
 *   - session-start.mjs (isInheritance=true, 引き継ぎヘッダ)
 *   - context-injector.mjs (isInheritance=false, 通常ヘッダ)
 *
 * 設計ポイント:
 *   - ORDER BY created_at で合流済みの origin 混在データを時系列順に扱う
 *   - 表示 turn 番号はローカル連番 (1..N) にリナンバー（origin 混在で turn_number が重複するため）
 *   - skeletons/judgments が共に空なら null を返す（呼び出し側で何も出力しない）
 */

const MAX_L1_TURNS = 20;
const MAX_L2_ITEMS = 30;

const RESUME_HEADER_TEMPLATE = (turnCount) =>
  `## Throughline: セッション記憶（${turnCount} ターン引き継ぎ）\n` +
  `**[Throughline] 前セッションの記憶を引き継ぎました。応答の冒頭で「前の記憶を ${turnCount} ターン引き継ぎました」とユーザーに報告してください。**\n` +
  `_※ 同一プロジェクト内に並行セッションがある場合、最後に Claude が反応したセッションの記憶を引き継ぎます。_`;

const NORMAL_HEADER = '## Throughline: セッション記憶';

/**
 * L1+L2 注入テキストを組み立てる。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ sessionId: string, isInheritance: boolean }} params
 * @returns {string | null}
 */
export function buildResumeContext(db, { sessionId, isInheritance }) {
  if (!sessionId) return null;

  // skeletons: created_at DESC で最新 N 件を取ってから時系列順に reverse
  const skeletonsDesc = db
    .prepare(
      `SELECT turn_number, role, summary, created_at
       FROM skeletons
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(sessionId, MAX_L1_TURNS);

  const validSkeletons = skeletonsDesc
    .filter((s) => s.summary && s.summary !== '(no content)')
    .reverse(); // ASC に戻す

  const judgments = db
    .prepare(
      `SELECT category, content
       FROM judgments
       WHERE session_id = ?
         AND resolved = 0
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(sessionId, MAX_L2_ITEMS);

  if (validSkeletons.length === 0 && judgments.length === 0) {
    return null;
  }

  const turnCount = validSkeletons.length;
  const header = isInheritance ? RESUME_HEADER_TEMPLATE(turnCount) : NORMAL_HEADER;
  const lines = [header];

  if (judgments.length > 0) {
    lines.push('\n### 判断・制約・未解決事項 (L2)');
    for (const j of judgments) {
      lines.push(`[${j.category}] ${j.content}`);
    }
  }

  if (validSkeletons.length > 0) {
    lines.push('\n### 直近のターン履歴 (L1)');
    // 表示用ローカル連番にリナンバー（origin 混在で turn_number が重複しうるため）
    for (let i = 0; i < validSkeletons.length; i++) {
      const s = validSkeletons[i];
      lines.push(`turn ${i + 1} [${s.role}]: ${s.summary}`);
    }
  }

  return lines.join('\n');
}
