# Session Linking Design（命題 X 実装設計）

このドキュメントは「`/clear` を跨いで旧 session_id と新 session_id を紐づける」機構の設計と実験プロトコルを定義する。

関連: [EXPERIMENT.md](EXPERIMENT.md) — 命題 A〜H、X、X-1 の生データと判定。

---

## 目的

`/clear` の前後で：
- 旧セッション A の session_id
- 新セッション A2 の session_id

を **1 対 1 で紐づける**。紐づけは「新セッションのユーザー最初の発言より前」に完了していること。

---

## 確定済みの前提（生データあり）

| 命題 | 内容 | 参照 |
|---|---|---|
| C | Stop フックの stdin に旧 session_id が含まれる | hooks.log 9614 行 |
| D | `/clear` 後の最初の UserPromptSubmit で新 session_id が届く | hooks.log 9656 行 |
| G | Stop はアシスタント応答完了ごとに毎ターン発火する | hooks.log 9493/9532, 9574/9614 |
| H | SessionStart は UserPromptSubmit より約 3 秒前に発火し、新 session_id が届く | session-start.log 05:53:31.674Z / hooks.log 05:53:34.961Z |

これらから、**Stop で旧 ID をファイルに書き、SessionStart で読む**方式が成立する見込み。

---

## 設計

### 全体フロー

```
[セッション A]
  ユーザー発言 → アシスタント応答 → Stop 発火
    → session-link-writer.mjs が
       ~/.throughline/session-link/<project_hash>.json に
       { old_session_id: A, ts: now, state: "open" } を書き込む（毎ターン上書き）

ユーザーが /clear を実行

[セッション A2 開始]
  SessionStart 発火（UserPromptSubmit より約 3 秒前）
    → session-link-reader.mjs が上記ファイルを読む
       判定:
         - state != "open" なら skip（既に消費済み）
         - now - ts > 10_000ms なら skip（窓切れ）
         - old_session_id == new_session_id なら skip（自己参照）
         - それ以外: リンク実行 → state = "closed" に書き戻す

  UserPromptSubmit 発火
    → context-injector.mjs が新 session_id の記憶を取り出す
       （リンク済みなので旧 A の記憶は A2 に紐づいている）
```

### データ構造

**リンク状態ファイル**: `~/.throughline/session-link/<project_hash>.json`

`project_hash` = `sha256(cwd).slice(0, 16)`。cwd は Stop/SessionStart 双方で届くため一意な鍵になる。

```json
{
  "old_session_id": "a2335bc7-c354-4172-ab89-abff7c7b6ee6",
  "transcript_path": "C:\\Users\\kite_\\.claude\\projects\\...",
  "cwd": "c:\\Users\\kite_\\Documents\\Program\\Throughline",
  "ts": 1712345678901,
  "state": "open"
}
```

**監査ログ**: `~/.throughline/session-link/link.log`（append-only JSONL）

各操作（write / read-hit / read-miss-closed / read-miss-stale / read-miss-self / link-success）を 1 行 JSON で記録。実験後に grep で検証可能。

### 10 秒受付窓

- **目的**: 古いファイル（Claude Code を長時間閉じて再開した等）を無視する
- **判定**: `Date.now() - entry.ts > 10_000` で stale 扱い
- **例外**: なし。10 秒を過ぎたら問答無用でスキップ

### 紐づけ完了後の「受付終了」

- **目的**: 同じ旧 ID を二重にリンクしない・紐づけ成立後の上書きで既成リンクを壊さない
- **方法**: リンク成功後に `state = "closed"` をファイルに書き戻す
- **自動再開**: 次の Stop（次ターンのアシスタント応答完了時）が `state = "open"` で新しい {old, ts} を書き込むので、次の `/clear` に備える

### 並行セッション問題（X-1）の扱い

**残る穴**: 「A の最後の Stop」と「A の /clear」の間に「B の Stop」が挟まると、A2 SessionStart が B を旧 ID と誤認する可能性がある。

**今回の実装での方針**: 既知の穴として許容。実用上、同一 project_path で並行セッションを走らせるケースは少ないと想定。監査ログから誤リンクが検出できるようにする（cwd・transcript_path の整合チェック）。

---

## 実装ファイル

```
spike/
├── session-link-common.mjs    共通（project_hash 計算、ファイル読み書き、ログ）
├── session-link-writer.mjs    Stop フック追加（旧 ID 書き込み）
└── session-link-reader.mjs    SessionStart フック追加（読み取り・リンク・クローズ）
```

spike 配下に置くのは、本実装ではなく**命題 X の実測検証**が目的のため。実測で成立が確認できたら `src/session-linker.mjs` に昇格する。

DB への実リンク処理（sessions テーブル更新）は**この実験では行わない**。まずは「読み書きとタイミングが期待通り動くか」だけを確認する。リンク成功時は `link.log` に記録するだけ。

---

## 実験プロトコル

### 準備

1. `.claude/settings.json` の Stop と SessionStart に spike フックを追加
2. ユーザーに「次の応答を待って `/clear` → 任意のメッセージ」と依頼

### 検証項目

| 項目 | 期待 | 確認方法 |
|---|---|---|
| 1. Stop で書き込みが起きる | `link.log` に `op: "write"` エントリ、対応する `<project_hash>.json` が `state: "open"` で存在 | ファイル確認 |
| 2. `/clear` 後の SessionStart で読み取りが起きる | `link.log` に `op: "read-hit"` または類似エントリ、elapsed < 10000ms | ログ確認 |
| 3. 旧 ID と新 ID が異なることを記録できる | `link.log` に `old`, `new` が別 UUID で記録される | ログ確認 |
| 4. SessionStart が UserPromptSubmit より前に実行される | `link.log` のタイムスタンプと hooks.log の UserPromptSubmit を比較 | 突き合わせ |
| 5. リンク成功後 `state: "closed"` になっている | ファイル確認 | 直接 cat |
| 6. 次の Stop で再び `state: "open"` に戻る | 次ターン末尾で確認 | 直接 cat |

### 成功条件

項目 1〜5 がすべてログとファイルで確認できれば命題 X は実測確定。

### 失敗時の切り分け

- 1 が無い → Stop フックに spike が登録されていない / パス間違い
- 2 が無い → SessionStart が `/clear` で発火していない（命題 E 再検証）
- 2 の elapsed > 10s → /clear から SessionStart まで 10 秒以上かかっている（窓拡張 or 起点変更を検討）
- 3 で old == new → そもそも /clear が session_id を変えていない（命題 A 再検証）
- 4 で SessionStart が後なら → タイミング前提が崩壊（命題 H 再検証）

---

## 次ステップ

1. このドキュメントに従って spike 実装を作成
2. settings.json に登録
3. ユーザーに `/clear` 実験を依頼
4. `link.log` と hooks.log を突き合わせて命題 X を判定
5. 成立すれば `src/session-linker.mjs` に昇格し、DB リンク処理を追加

---

## 最終決定 (2026-04-15)

### 採用されなかった案

**命題 X のファイルベース紐付け**: spike/session-link-*.mjs で実装したが、命題 G（並行セッション）のケースで曖昧性が残ったため本番採用見送り。10 秒窓に複数 Stop が入ったときの同定ができない。

**ppid 相関仮説**: 「同じ Claude Code プロセスから生まれた hook プロセスは `process.ppid` が共通のはず」という仮説を実機検証 (`docs/EXPERIMENT.md` 参照)。結果は**不成立**:
- 同一セッション内の 2 つの hook 呼び出しでも ppid が異なる (75600 vs 132140)
- Windows + VSCode 拡張環境では hook プロセスの親世代が呼び出しごとに使い捨てされる
- WMI 照会時点で既に死亡しており親プロセス追跡も不可

**`/preclear` コマンド案**: ユーザーに `/preclear` を明示的に打たせて「この次に clear するぞ」というハンドシェイクを取る案。実装シンプルだがユーザー規律依存で頑健性に欠けるため不採用。

### 採用した案: 記憶張り替え (Relabel) 方式

`SessionStart` フックで以下を行う:

1. `sessions` テーブルに新 session_id を INSERT OR IGNORE
2. 同 `project_path` で `merged_into IS NULL` の最新 `updated_at` セッションを前任候補として SELECT
3. 前任候補があれば、その skeletons / judgments / details の `session_id` を新 session_id に UPDATE（張り替え）
   - `origin_session_id` は既存値を保持 → 系譜追跡
4. 前任 `sessions.merged_into = 新 session_id`、新 `sessions.updated_at = now`
5. `BEGIN IMMEDIATE` トランザクションで原子性確保
6. 合流成立なら `buildResumeContext(isInheritance=true)` で引き継ぎヘッダ付き L1+L2 を stdout 注入

### 実機確認 (2026-04-15)

`SessionStart` は `/clear` 後も `source="startup"` で発火する（`~/.throughline/spike/session-start.log` 実機ログ）。プラン時点の誤認「SessionStart は /clear 後には発火しない」は `source="clear"` が来ないだけで hook 自体は発火していたという事実。stdout の生テキスト注入も spike マーカーで動作確認済み。

### 張り替え方式の利点

- **チェーン蓄積**: 複数回の /clear を跨いでも記憶が同じ session_id 配下に集約される。1 ホップ制限なし
- **並行セッション誤認 (X-1) の扱い**: 「同 project_path で最後に Claude が反応したセッション」を前任候補とする単純ルール。受容し、注入ヘッダで明示
- **時間窓撤廃**: `CLEAR_CONTINUATION_MS` を削除。任意の古さの前任でも引き継ぎ可
- **SessionStart での早期注入**: ユーザーの初発言を待たずに記憶が戻る

### 既知の制約

1. **並行セッション誤認 (X-1)**: 受容、注入ヘッダに注意書き明示
2. **非常に古いセッションの復活**: 時間窓撤廃の副作用、許容
3. **張り替えの一方向性**: 合流後、元の session_id に戻す undo は提供しない
4. **初回ターンのコンテキスト冗長**: SessionStart 注入と UserPromptSubmit 注入の両方が会話先頭に並ぶ。合計トークン消費がやや増える
5. **mid-turn /clear で残留する NULL details**: 前任 PostToolUse が Stop 前に /clear された場合、`details.turn_number=NULL` のまま合流先に移る。L3 参照時に NULL 除外で対応

### スキーマ (v3)

```sql
-- 新規列
ALTER TABLE skeletons ADD COLUMN origin_session_id TEXT;
ALTER TABLE judgments ADD COLUMN origin_session_id TEXT;
ALTER TABLE details   ADD COLUMN origin_session_id TEXT;
ALTER TABLE sessions  ADD COLUMN merged_into TEXT;

-- UNIQUE 制約張り替え
DROP INDEX uq_skeletons_turn;
DROP INDEX uq_judgments_hash;
CREATE UNIQUE INDEX uq_skeletons_turn_v3
  ON skeletons(session_id, origin_session_id, turn_number, role);
CREATE UNIQUE INDEX uq_judgments_hash_v3
  ON judgments(session_id, origin_session_id, content_hash);

-- 検索用副次インデックス
CREATE INDEX idx_skeletons_session ON skeletons(session_id, created_at);
CREATE INDEX idx_judgments_session ON judgments(session_id, resolved, created_at);
```

### 主要モジュール

| ファイル | 役割 |
|---|---|
| `src/session-merger.mjs` | `resolveMergeTarget` (merged_into チェーン解決) / `mergePredecessorInto` (張り替え本体) |
| `src/resume-context.mjs` | L1+L2 レンダリング共有モジュール (isInheritance フラグで引き継ぎ/通常ヘッダ切替) |
| `src/session-start.mjs` | SessionStart hook: INSERT + merge + 引き継ぎ注入 |
| `src/context-injector.mjs` | UserPromptSubmit hook: 毎ターン通常注入 + merge 追従 |
| `src/turn-processor.mjs` | Stop hook: merge target に origin 記録付きで L1/L2 書き込み |
| `src/detail-capture.mjs` | PostToolUse hook: 同様に merge target 追従で L3 書き込み |
