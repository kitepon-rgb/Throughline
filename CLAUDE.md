# CLAUDE.md

このファイルは Claude Code がこのリポジトリで作業する際のガイダンスです。

## プロジェクト概要

**Throughline** は Claude Code の hooks プラグインです。  
会話ターンの内容を3層に分解して SQLite に保存し、`/clear` 後も記憶を復元します。

**設計思想：/clear-safe 永続記憶 + 記憶張り替え方式**
- `/clear` で会話を破棄しても SQLite はそのまま残る
- **`SessionStart` フックで前任セッションの L1/L2/L3 を新 session_id に張り替える**（DB 上の session_id を UPDATE）
- 張り替え成立時に「引き継ぎヘッダ」付きで新セッションに注入、以降は `UserPromptSubmit` フックで毎ターン通常注入
- **複数回の `/clear` を跨いで記憶がチェーン状に蓄積**（1 ホップ制限なし）
- 並行セッション時は「同プロジェクト内で最後に Claude が反応したセッション」を前任として引き継ぐ（注入ヘッダに注意書きを明示）
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` は **使わない**（自動コンパクト依存の設計は放棄済み）

設計背景：`docs/CONCEPT.md` を参照。

---

## 現在の実装状態（Phase 1 稼働中）

### 実装済みファイル

```
Throughline/
├── src/
│   ├── db.mjs                  ✅ SQLite管理（node:sqlite 組み込み、npm install 不要）
│   ├── token-estimator.mjs     ✅ トークン数推定（length/4、外部依存ゼロ）
│   ├── transcript-reader.mjs   ✅ JSONL パーサー
│   ├── detail-capture.mjs      ✅ PostToolUse hook: L3 保存（merge target 追従）
│   ├── turn-processor.mjs      ✅ Stop hook: L1 生成・turn_number 確定（merge target 追従）
│   ├── context-injector.mjs    ✅ UserPromptSubmit hook: 現セッションの L1+L2 再注入（merge 追従）
│   ├── session-start.mjs       ✅ SessionStart hook: 前任の張り替え + 引き継ぎ注入
│   ├── session-merger.mjs      ✅ 張り替え本体 (mergePredecessorInto / resolveMergeTarget)
│   ├── resume-context.mjs      ✅ L1+L2 レンダリング共有モジュール
│   └── throughline.mjs       残骸（旧設計の pass-through、使用されていない）
├── spike/                      Phase 0 確認スクリプト群
│   ├── hook-logger.mjs
│   ├── precompact-inject.mjs
│   ├── test-userpromptsubmit.mjs
│   ├── install-spike.mjs
│   ├── install-userpromptsubmit-spike.mjs
│   └── read-logs.mjs
├── docs/
│   └── CONCEPT.md              設計背景・コンセプト（旧 throughline-concept.md）
├── package.json                依存なし（node:sqlite は Node.js 組み込み）
└── install.mjs                 ✅ hooks セットアップ（冪等、--uninstall 付き）
```

### 稼働確認済み事実

| 事実 | 確認方法 |
|------|---------|
| `PostToolUse` フック: stdin に `session_id`, `tool_name`, `tool_input`, `tool_response`, `transcript_path` が届く | spike ログ |
| `Stop` フック: stdin に `session_id`, `transcript_path` が届く | spike ログ |
| `PreCompact` フック: stdin に `trigger`, `context` 等が届き、stdout の `additionalContext` が注入される | spike ログ |
| `UserPromptSubmit` フック: stdin に `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt` が届く | spike ログ |
| `node:sqlite` (`DatabaseSync`) が Node.js v24 で動作する（実験的警告あり、stderr に出るだけ） | 実行確認 |
| Phase 1 hooks がこのセッション自体のデータをキャプチャしている（DB に実データ蓄積済み） | DB 確認 |
| トランスクリプト JSONL の実フォーマット: `{type:"user"\|"assistant", message:{role, content:[{type:"text",text:"..."}]}, ...}` — `role`/`content` は `entry.message` の中にある（直接ではない）。thinking ブロックは除外して text ブロックのみ結合する | JSONL 実機確認 |
| Phase 2 実装済み: `classifier.mjs`（ヒューリスティック L2 分類）、`turn-processor.mjs` が L2 judgments を書くように更新済み | 実行確認 |
| `UserPromptSubmit` の注入フォーマット: **生テキスト出力（JSON ラッパーなし）**。`{"additionalContext":"..."}` は届かない。`process.stdout.write(text)` で直接書くと Claude のコンテキストに注入される | spike 実機確認済み |
| `SessionStart` フック: `/clear` 後も `source="startup"` で発火し、新 `session_id` が stdin で届く（Windows + VSCode 拡張では `source="clear"` は来ないが hook 自体は発火する） | 2026-04-15 実機確認 (`~/.throughline/spike/session-start.log`) |
| `SessionStart` の stdout 生テキスト注入が会話冒頭のシステムメッセージとして機能する | 2026-04-15 実機確認 (spike marker) |
| schema v3: `skeletons/judgments/details.origin_session_id`, `sessions.merged_into` 列追加済み、張り替え方式対応 | 実行確認 |

### 現在の .claude/settings.json hooks 構成

```json
{
  "PostToolUse": [
    { "matcher": "Bash|Write|Edit|Read|Grep|Glob", "hooks": [{ "type": "command", "command": "node src/detail-capture.mjs" }] },
    { "matcher": "Bash|Write|Edit|Read|Grep|Glob", "hooks": [{ "type": "command", "command": "node spike/hook-logger.mjs PostToolUse" }] }
  ],
  "Stop": [
    { "hooks": [{ "type": "command", "command": "node src/turn-processor.mjs" }] },
    { "hooks": [{ "type": "command", "command": "node spike/hook-logger.mjs Stop" }] }
  ],
  "PreCompact": [
    { "hooks": [{ "type": "command", "command": "node spike/precompact-inject.mjs" }] }
  ],
  "UserPromptSubmit": [
    { "hooks": [{ "type": "command", "command": "node src/context-injector.mjs" }] },
    { "hooks": [{ "type": "command", "command": "node spike/test-userpromptsubmit.mjs" }] }
  ]
}
```

spike の hooks は残っているが害はない。Phase 2 で `node install.mjs` を再実行すれば整理できる。

---

## アーキテクチャ

### 3層コンテキストモデル

| 層 | 名称 | コンテキスト | 内容 | トークンコスト |
|----|------|-------------|------|---------------|
| **L1** | 骨格 (Skeleton) | 常駐 | ターンの意図と結論の1行サマリ | ~10 tok/turn |
| **L2** | 判断 (Judgment) | 常駐 | 構造化された決定・制約・問題 | ~50 tok/turn |
| **L3** | 詳細 (Detail) | SQLite に退避 | 生のツール I/O | ~2,000+ tok/turn |

### L2 分類カテゴリ

```
DECISION   — 技術的な決定
CONSTRAINT — 禁止事項・前提条件
CONTEXT    — 背景・要件
IMPL       — 完了済み作業のサマリ
ISSUE      — バグ・TODO・未解決事項（resolved になるまで常に注入）
```

### フロー（/clear-safe パターン + 張り替え方式）

```
各ターン:
  PostToolUse → detail-capture.mjs → L3 を details テーブルに保存（turn_number=NULL, origin_session_id=入力 session）
                                   ※ 入力 session が merged_into を持つ場合、合流先 (target) に書き込む
  Stop        → turn-processor.mjs → L1 生成 + L2 分類、turn_number 確定
                                   ※ 同様に merge target 追従
  UserPromptSubmit → context-injector.mjs → 現セッション（merge 追従後）の L1+L2 を毎ターン注入

/clear 実行時:
  会話破棄。SQLite はそのまま残る。

新セッション発生:
  SessionStart (source=startup) → session-start.mjs
    1. sessions テーブルに INSERT OR IGNORE
    2. 同 project_path で merged_into IS NULL の最新 updated_at セッションを前任として選ぶ
    3. 前任 skeletons/judgments/details の session_id を新 session_id に UPDATE（張り替え）
       origin_session_id は既存値 = 前任 session を保持（系譜記録）
    4. 前任 sessions.merged_into = 新 session_id、新 sessions.updated_at = now
    5. 合流成立なら buildResumeContext(isInheritance=true) で引き継ぎヘッダ付き注入

以降のユーザー発言:
  UserPromptSubmit → context-injector.mjs → 張り替え済みの新 session_id から通常ヘッダで L1+L2 注入
```

### チェーン蓄積の性質

複数回の `/clear` を跨いでも、張り替えにより記憶は「同じ session_id 配下」に集約される:

```
S1 (4 turns) -- /clear --> S2 (merges S1, adds 3 turns) -- /clear --> S3 (merges S2, ...)
                           skeletons now has 4+3 rows under S2      skeletons now has 7+ rows under S3
                           origin=S1 (×4), origin=S2 (×3)          origin=S1 (×4), origin=S2 (×3), origin=S3 (×N)
```

`origin_session_id` により UNIQUE 制約 `(session_id, origin_session_id, turn_number, role)` は原点違いで共存可能。表示時は `created_at` 順にローカル連番リナンバー。

### SQLite

- **パス**: `~/.throughline/throughline.db`（WAL モード）
- **ライブラリ**: `node:sqlite`（Node.js v22.5+ 組み込み、`npm install` 不要）
- **注意**: `better-sqlite3` は Node.js v24 + MSVC でビルド失敗するため使用しない

### テーブル (schema v3)

| テーブル | 内容 |
|---------|------|
| `sessions` | session_id, project_path, status, created_at, updated_at, **merged_into** |
| `skeletons` | L1: session_id, **origin_session_id**, turn_number, role, summary |
| `judgments` | L2: session_id, **origin_session_id**, turn_number, category, content, content_hash, resolved |
| `details` | L3: session_id, **origin_session_id**, turn_number, tool_name, input_text, output_text, token_count |
| `injection_log` | 注入イベントの監査ログ |

**UNIQUE 制約**:
- `skeletons`: `(session_id, origin_session_id, turn_number, role)`
- `judgments`: `(session_id, origin_session_id, content_hash)`

**merged_into**: NULL なら未合流（= 前任候補）、値あれば合流先 session_id。次回 SessionStart の前任候補選択で `merged_into IS NULL` でフィルタ。

---

## コマンド

```bash
# hooks セットアップ（冪等）
node install.mjs

# hooks 削除
node install.mjs --uninstall

# spike logs 確認
node spike/read-logs.mjs

# DB 直接確認
node --input-type=module <<'EOF'
import { getDb } from './src/db.mjs';
const db = getDb();
console.log(db.prepare('SELECT * FROM sessions').all());
console.log(db.prepare('SELECT * FROM skeletons').all());
EOF
```

hooks スクリプトは Claude Code から直接呼び出される（npm 経由ではない）:

```bash
node src/detail-capture.mjs   # PostToolUse hook
node src/turn-processor.mjs   # Stop hook
node src/context-injector.mjs # UserPromptSubmit hook
node src/session-start.mjs    # SessionStart hook（張り替え + 引き継ぎ注入）
```

---

## 開発フェーズ

**Phase 0（スパイク）: ✅ 完了**
- PostToolUse / Stop / PreCompact / UserPromptSubmit フックの stdin 契約確認
- `additionalContext` 注入の動作確認

**Phase 1（MVP）: ✅ 稼働中**
- db.mjs, token-estimator.mjs, transcript-reader.mjs
- detail-capture.mjs（PostToolUse: L3 保存）
- turn-processor.mjs（Stop: L1 生成）
- context-injector.mjs（UserPromptSubmit: 再注入）
- install.mjs

**Phase 2（構造化記憶）: 部分実装**
- `src/classifier.mjs` ✅ — ヒューリスティック L2 分類（誤検知対策済み）
  - ISSUE 否定パターン: 「修正済み」「解決済み」「仮説だが否定された」等で抑制
  - 過去文脈パターン: 「〜ていたが」「以前は」「原因は」等で抑制
  - `classifyAssistantParagraph()` — アシスタントテキスト専用の厳格な判定
- L2 重複排除（content_hash + UNIQUE INDEX） ✅
- `turn-processor.mjs` → judgments 書き込み ✅
- `UserPromptSubmit` 生テキスト注入 ✅ 確認済み・本番適用済み
- `/sc-detail <turn>` スラッシュコマンド — 未着手
- `injection_log` 効果測定 — 未着手

**Phase 2.5（記憶張り替え）: ✅ 実装完了 (2026-04-15)**
- schema v3: `origin_session_id`, `merged_into` 列追加、UNIQUE 制約張り替え
- `src/session-merger.mjs` ✅ — `resolveMergeTarget` / `mergePredecessorInto`（BEGIN IMMEDIATE トランザクション）
- `src/resume-context.mjs` ✅ — L1+L2 レンダリング共有モジュール、表示 turn 番号ローカル連番
- `src/session-start.mjs` ✅ — 張り替え + 引き継ぎ注入 (isInheritance=true)
- `src/context-injector.mjs` ✅ — resolveMergeTarget で合流後の元セッションも追従
- `src/turn-processor.mjs` / `src/detail-capture.mjs` ✅ — INSERT に `origin_session_id` 追加、merge target 追従
- 時間窓 `CLEAR_CONTINUATION_MS` 撤廃（任意の古さでも引き継ぎ）
- 並行セッション時は「最後に Claude が反応したセッション」を前任として引き継ぐ（注意書きをヘッダに明示）

**Phase 3（公開）: 計画中**
- GitHub 公開、npm 配布、CI、README
- 公開配布化の詳細計画: [docs/PUBLIC_RELEASE_PLAN.md](docs/PUBLIC_RELEASE_PLAN.md)

---

## 技術スタック

- **ランタイム**: Node.js v22.5+、ESM（`.mjs` 統一）
- **データベース**: `node:sqlite`（Node.js 組み込み、同期 API）
- **外部依存**: なし
- **対応プラットフォーム**: Windows、Linux、macOS
