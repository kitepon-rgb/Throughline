# 引き継ぎ発火条件の絞り込み調査 & 実装計画

## Status (2026-04-18 更新)

- **Phase 0 実機検証: 完了**
- **案 A 不成立**: VSCode 拡張 2.1.112 でも /clear 後の SessionStart は `source="startup"` で発火 (probe ログ 30 件中 startup 29 / resume 1)。公式 docs / MINGW64 環境と挙動が異なる既知差異
- **案 C 不成立**: SessionStart 発火時点で transcript ファイルは未作成
- **案 D（時間差ヒューリスティック）: 撤回**。誤爆の可能性を排除できず、ユーザー明示指名の方が決定論的で意図が明確
- **採用: バトン方式（案 E）**: 旧セッションで `/tl` スラッシュコマンドを打つと UserPromptSubmit hook が `handoff_batons` テーブルに session_id を書き込み、次の新規セッションの SessionStart が TTL 1 時間以内のバトンを消費して merge する
  - 実装: [src/baton.mjs](../src/baton.mjs), [src/prompt-submit.mjs](../src/prompt-submit.mjs), [src/session-start.mjs](../src/session-start.mjs), [src/session-merger.mjs](../src/session-merger.mjs) (`mergeSpecificPredecessor`), [.claude/commands/tl.md](../.claude/commands/tl.md)
  - Bash tool サブプロセスには `$CLAUDE_SESSION_ID` 相当の env が無いため、session_id は UserPromptSubmit hook payload から取得する
- **GitHub issue**: [anthropics/claude-code#49937](https://github.com/anthropics/claude-code/issues/49937) 提出済み。修正されれば source ベースに戻す余地は残る

## Context

Throughline の SessionStart フックは現在 **同一 project_path の未合流セッションがあれば無条件で記憶を引き継いでいる**。そのため以下が起きている:

- ユーザーが `/clear` していないのに手動で新規セッションを始めると、前任の記憶が引き継がれて「90 ターン引き継ぎました」と注入される（**最優先で解消したい挙動**）
- VSC を再起動して完全新規セッションを開いた場合も同様に引き継がれる

ユーザーの望む挙動: **`/clear` 直後の新規セッションのときだけ** 前任を引き継ぎ、手動新規・VSC 再起動後の新規では引き継がない。

## Findings (2026-04-17 時点)

### 現行実装 (根拠: [src/session-start.mjs](../src/session-start.mjs), [src/session-merger.mjs](../src/session-merger.mjs))

- [src/session-start.mjs:33](../src/session-start.mjs#L33) で payload の `source` を **読み捨てている**
- [src/session-start.mjs:48-51](../src/session-start.mjs#L48-L51) で無条件に `mergePredecessorInto` を呼ぶ
- [src/session-merger.mjs:68-78](../src/session-merger.mjs#L68-L78) の前任選定は「同 project_path・未合流・自分より created_at が古い・最新 updated_at」のみで、source や時間窓は見ていない

### 過去ログは参考扱い

- `C:\Users\kite_\.throughline\spike\session-start.log` の 93 件は Opus 4.6 以前の採取で、モデル更新（現 4.7）と Claude Code バージョン更新を跨いでいる
- 「startup 76 / resume 16 / clear 1」の分布はあくまで参考値で、現行環境の挙動として採用しない
- コメント [src/session-start.mjs:7-10](../src/session-start.mjs#L7-L10) の「/clear 後も source='startup'」も当時の観察で、現行環境で再検証する

### 確定したい前提

**「/clear 直後の SessionStart は `source === 'clear'` で識別できる」** を現行環境で実証できれば、案 A が成立する。できなければ別アプローチ（時間差 / transcript マーカー）に切り替える。

## 想定アプローチ（合意用の選択肢）

### 案 A: `source === "clear"` のみ引き継ぐ（シンプル案）

- [src/session-start.mjs](../src/session-start.mjs) で `source !== 'clear'` なら `mergePredecessorInto` を呼ばない
- 取りこぼし（startup で来る /clear）は許容
- ユーザー視点: 「手動新規・VSC 再起動・一部の /clear」で真に新規、それ以外は引き継ぐ

### 案 B: `source === "clear"` + 時間差ヒューリスティック

- 案 A に加え、`source === "startup"` でも **前任の updated_at が N 秒以内**（候補: 60 秒）なら /clear 由来とみなし引き継ぐ
- 取りこぼしを減らせるが、「手動新規を早いタイミングで開いた」ケースを /clear と誤判定するリスクあり

### 案 C: transcript マーカー判定

- 新 transcript の先頭に `<command-name>/clear</command-name>` が残っていれば /clear 由来と判定
- 未検証前提が多く、Claude Code 側の仕様変更で壊れやすい

## 推奨アプローチ

**Phase 0 で `source` の実測 → 結果次第で案 A or B を確定 → 実装**。

- Phase 0 の結果、/clear で必ず `source='clear'` が来る & 手動新規・VSC 再起動では絶対に来ないことが確認できれば **案 A** で確定
- /clear で `source='startup'` が混じる場合は **案 B**（時間差ヒューリスティック併用）に切り替え
- いずれも案 C（transcript マーカー）は fallback として deferred

## Phase 0: 実機検証（実装前に必ず実施）

**目的**: 現行環境（Opus 4.7 / 最新 Claude Code）で SessionStart payload の `source` が /clear / 手動新規 / VSC 再起動でそれぞれ何になるかを確定する。

### 手順

1. **debug ロガーを [src/session-start.mjs](../src/session-start.mjs) に一時挿入**
   - payload を受け取った直後（L32 の JSON.parse 直後）に `{ ts, source, session_id, transcript_path, cwd }` を `C:\Users\kite_\.throughline\logs\sessionstart-probe.log` に追記
   - 既存のマージ処理には触れない（挙動を変えずに観測だけする）
   - 1 行 1 JSON (JSONL) 形式で append

2. **ユーザー手動で 3 ケース × 複数回の実機採取**
   - **ケース 1: /clear 後の新規セッション** — チャット中に `/clear` 実行 → SessionStart 発火 → 1 行ログ取得 × 3 回以上
   - **ケース 2: 手動新規セッション** — VSC 内で新規チャット作成操作 → SessionStart 発火 → 1 行ログ取得 × 3 回以上
   - **ケース 3: VSC 再起動直後** — VSC を終了 → 起動 → Throughline 有効なプロジェクトを開いた直後 → 1 行ログ取得 × 3 回以上

3. **集計と判定**
   - ケース 1 が **全回 `source='clear'`** → 案 A 確定
   - ケース 1 に `startup` が混じる / ケース 2 または 3 に `clear` が混じる → 案 B に切り替えて時間差閾値を設計

4. **debug ロガー撤去**
   - 判定後は [src/session-start.mjs](../src/session-start.mjs) から削除（commit 分離）

## 実装ステップ（案 A 前提・Phase 0 通過後に実施）

1. **[src/session-start.mjs](../src/session-start.mjs) 修正**
   - L33: `const { session_id, source, cwd } = payload` に変更して `source` を取得
   - L7-10 のコメントを実機ログに合わせて更新（「source='clear' のときだけ引き継ぐ。startup で来る /clear は取りこぼす」仕様を明記）
   - L48 付近: `if (source === 'clear') { mergePredecessorInto(...) }` でガード
   - 引き継がない場合も [src/session-start.mjs:41-45](../src/session-start.mjs#L41-L45) の sessions INSERT は従来通り実行（DB には残す）

2. **[src/session-merger.test.mjs](../src/session-merger.test.mjs) にテスト追加**
   - `resolveMergeTarget` / `mergePredecessorInto` は現状維持（判定は session-start 側に持たせる）
   - 代わりに session-start.mjs の条件分岐をユニット化する。テストは薄めの統合で:
     - source='clear' → `mergePredecessorInto` が呼ばれ合流する
     - source='startup' → 呼ばれず前任 sessions の merged_into が NULL のまま
     - source='resume' → 同上
   - 既存 [src/session-merger.test.mjs:121-151](../src/session-merger.test.mjs#L121-L151) の時系列単調性テストは引き続きパスする前提

3. **[src/resume-context.mjs](../src/resume-context.mjs) と注入ヘッダ**
   - 注入は session-start.mjs 側の `mergeResult.merged` 分岐で既に制御されているので修正不要
   - ただし「同一 session 継続（source='resume'）での注入」が必要か要検討。現状の resume フックは本計画のスコープ外として deferred（別タスクで検討）

4. **[docs/L1_L2_L3_REDESIGN.md](L1_L2_L3_REDESIGN.md) / [CLAUDE.md](../CLAUDE.md) / [README.md](../README.md) の更新**
   - 「記憶張り替えの発火条件は SessionStart source='clear' のみ」を明記
   - CLAUDE.md 冒頭「設計の核」の「`/clear` 後も SQLite はそのまま残る。`SessionStart` フックで前任セッションの全レコードを新 session_id に張り替える」の直後に引き継ぎ条件を追記

## 最終検証手順（Phase 0 通過 & 案 A 実装後）

1. `node --test src/*.test.mjs` が全部グリーン（既存 + 追加ケース）
2. 手動 E2E:
   - Throughline 有効状態で VSC を終了
   - VSC 再起動 → 新規セッション → 引き継ぎヘッダが **出ない** ことを確認
   - そのセッション内で `/clear` → 新規セッション → 引き継ぎヘッダが **出る** ことを確認（source='clear' が来たケース）
   - 同じ操作を 3 回繰り返し、source='startup' で /clear した回のスキップが許容範囲か観測
3. `C:\Users\kite_\.throughline\throughline.db` を直接確認:
   ```bash
   node --input-type=module <<'EOF'
   import { getDb } from './src/db.mjs';
   const db = getDb();
   console.log(db.prepare("SELECT session_id, merged_into, created_at FROM sessions ORDER BY created_at DESC LIMIT 10").all());
   EOF
   ```
   - 手動新規 / VSC 再起動時の `merged_into` が NULL のまま残ること
   - /clear 後のセッションでのみ前任の `merged_into` が新 session_id を指すこと

## 重要ファイル一覧

- [src/session-start.mjs](../src/session-start.mjs) — 主変更箇所
- [src/session-merger.mjs](../src/session-merger.mjs) — 参照のみ（現状維持）
- [src/session-merger.test.mjs](../src/session-merger.test.mjs) — テスト追加
- [src/resume-context.mjs](../src/resume-context.mjs) — 参照のみ
- [CLAUDE.md](../CLAUDE.md) / [docs/L1_L2_L3_REDESIGN.md](L1_L2_L3_REDESIGN.md) / [README.md](../README.md) — ドキュメント更新

## Non-Goals (本計画では扱わない)

- VSC 拡張側の source 送信挙動の調査・修正（Claude Code 本体のスコープ）
- 並行セッション X-1 問題の解決（[docs/archive/SESSION_LINKING_DESIGN.md:194](archive/SESSION_LINKING_DESIGN.md#L194) で受容済み）
- source='startup' で来る /clear の取りこぼし対策（案 B/C は fallback として deferred）
- token-monitor / sc-detail 系 CLI への影響調査（本計画と独立）
