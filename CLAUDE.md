# CLAUDE.md

このファイルは Claude Code がこのリポジトリで作業する際のガイダンスです。

## プロジェクト概要

**Throughline** は Claude Code の hooks プラグインで、会話ターンを 3 層 (L1/L2/L3) に分解して SQLite に保存し、`/clear` 後も記憶を復元します。加えてマルチセッション対応のトークンモニター CLI も同梱しています。

**設計の核**

- `/clear` 後も SQLite はそのまま残る。`SessionStart` フックで前任セッションの全レコードを新 session_id に張り替える（記憶張り替え方式）
- **引き継ぎ発火条件はユーザー明示のバトンのみ**。旧セッションで `/tl` スラッシュコマンドを打つと UserPromptSubmit hook が `handoff_batons` テーブルに session_id を書き込み、次の新規セッションがそれを TTL 1 時間以内に限り消費して merge する。バトンが無ければ一切引き継がない
- **in-flight メモ** (v7): `/tl` を打った後、旧セッションの Claude 自身が `throughline save-inflight` CLI 経由で「次の一手 / 現在の方針 / 未解決 / 進行中 TODO」を Markdown で `handoff_batons.memo_text` に書き込む。次セッションの resume-context 先頭にそのメモと最終ターンの thinking を注入することで「中断地点からの再開」感を復元する
- **thinking の L3 保存**: assistant の extended thinking ブロックを `details` テーブルに `kind='thinking'` で全ターン保存。最新ターンの thinking は SessionStart 注入に含まれ、古い thinking は `throughline detail <時刻>` で取り出せる
- バトン方式の背景: VSCode 拡張では SessionStart の `source` が /clear 後も `startup` に潰されるため source 判定では /clear を識別できない（[GitHub issue #49937](https://github.com/anthropics/claude-code/issues/49937)）。時間差ヒューリスティック（案 D）は誤爆リスクがあり撤回。詳細は [docs/INHERITANCE_ON_CLEAR_ONLY.md](docs/INHERITANCE_ON_CLEAR_ONLY.md)
- 各レコードは `origin_session_id` を保持するため、複数回の `/tl` 経由引き継ぎでも記憶がチェーン状に蓄積する（ホップ制限なし）
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` は **使わない**（自動コンパクト依存の設計は放棄済み）
- **フォールバック / 逃げ道のコードを書かない** — [docs/PUBLIC_RELEASE_PLAN.md §0](docs/PUBLIC_RELEASE_PLAN.md) 参照。silent try/catch、`exit(0)` でのエラー隠蔽は禁止

---

## 必読ドキュメント

作業を始める前に以下を読むこと。**憶測で設計を推測しない。ソースと設計書が根拠。**

| ドキュメント | 内容 |
|---|---|
| [docs/L1_L2_L3_REDESIGN.md](docs/L1_L2_L3_REDESIGN.md) | **L1/L2/L3 記憶レイヤーの設計仕様**。ブロック分類ルール、Haiku 呼び出し方針、実装順序、進捗表。schema v4 基盤 + v5 L3 分類拡張まで。以後の v6/v7 追加は本文書とは独立 |
| [docs/INHERITANCE_ON_CLEAR_ONLY.md](docs/INHERITANCE_ON_CLEAR_ONLY.md) | `/tl` バトン引き継ぎ方式の設計判断記録（schema v6/v7）。ヒューリスティック方式を却下した理由と、現行の明示指名方式の経緯 |
| [docs/PUBLIC_RELEASE_PLAN.md](docs/PUBLIC_RELEASE_PLAN.md) | 公開配布化プラン（§0 フォールバック禁止ルール、CLI 設計、バージョン別実装ステータス、E2E 検証手順、未完タスク） |
| [README.md](README.md) | ユーザー向け説明（Quick Start、3 層モデル、CLI、schema v7、VSCode 自動起動、monitor 診断、中断地点からの再開、トラブルシュート） |
| [docs/archive/](docs/archive/) | 破棄された旧設計（CONCEPT.md 初期案、session linking 実験記録、npm publish 前のアクションメモ等）。歴史記述用 |

---

## 実装済みファイルの役割

ソースの現状は **常にコードを見て確認する**。以下は索引のみ。

### コア

| ファイル | 役割 |
|---|---|
| [src/db.mjs](src/db.mjs) | SQLite 接続、schema v1 → v7 migration。`node:sqlite` 組み込み、依存ゼロ |
| [src/transcript-reader.mjs](src/transcript-reader.mjs) | transcript JSONL パーサー |
| [src/transcript-usage.mjs](src/transcript-usage.mjs) | 最新 assistant の `message.usage` から実測トークン数を抽出、1M context 検出 |
| [src/token-estimator.mjs](src/token-estimator.mjs) | 補助的なトークン数推定 (length/4) |

### Hook 実装（CLI 経由で呼ばれる）

| ファイル | サブコマンド | Hook event |
|---|---|---|
| [src/session-start.mjs](src/session-start.mjs) | `throughline session-start` | SessionStart |
| [src/turn-processor.mjs](src/turn-processor.mjs) | `throughline process-turn` | Stop |
| [src/prompt-submit.mjs](src/prompt-submit.mjs) | `throughline prompt-submit` | UserPromptSubmit |

### 記憶張り替え・注入共通

| ファイル | 役割 |
|---|---|
| [src/baton.mjs](src/baton.mjs) | `writeBaton` / `consumeBaton` / `updateBatonMemo`（`/tl` で書き、`save-inflight` で memo 付与、SessionStart で消費） |
| [src/session-merger.mjs](src/session-merger.mjs) | `resolveMergeTarget` / `mergeSpecificPredecessor`（BEGIN IMMEDIATE トランザクション） |
| [src/resume-context.mjs](src/resume-context.mjs) | 「中断地点からの再開」注入テキスト組み立て（in-flight メモ → 最終ターン thinking → L1 → L2 の順） |
| [src/state-file.mjs](src/state-file.mjs) | セッション単位の状態ファイル (`~/.throughline/state/<session_id>.json`)。`usage` フィールド (tokens/model/contextWindowSize) を Stop 完了時に固定保存 — monitor が JSONL を再スキャンせずに済むようにする。旧フォーマット (usage 無し) も読める |
| [src/haiku-summarizer.mjs](src/haiku-summarizer.mjs) | `claude -p --model claude-haiku-4-5-*` subprocess 呼び出し（再帰ガード 2 重） |
| [src/vscode-task.mjs](src/vscode-task.mjs) | VSCode の `.vscode/tasks.json` を初回 Stop で自動プロビジョニング（token-monitor の folderOpen 自動起動）。純 JSON は安全にマージ、JSONC は触らず stderr で手動手順を 1 度だけ案内。冪等性ガード付き |
| [src/terminal-size.mjs](src/terminal-size.mjs) | OSC 18t (`\x1b[18t`) で端末に実幅を問い合わせるユーティリティ。Windows ConPTY + VSCode task terminal では `process.stdout.columns` が凍結するので、stdin を raw mode で listen して `\x1b[8;rows;cols t` 応答を parse する。Ctrl+C 検知 (0x03) と stop() での raw mode 解除も担当 |

### CLI

| ファイル | サブコマンド |
|---|---|
| [bin/throughline.mjs](bin/throughline.mjs) | ディスパッチャ |
| [src/cli/install.mjs](src/cli/install.mjs) | `install` / `uninstall`（デフォルト global、`--project` でローカル） |
| [src/cli/doctor.mjs](src/cli/doctor.mjs) | `doctor` — 環境チェック。`doctor --session <id-prefix>` で特定セッションの state/transcript 整合性を診断（「モニターが止まって見える」時の切り分け用） |
| [src/cli/status.mjs](src/cli/status.mjs) | `status` — DB 統計表示 |
| [src/cli/save-inflight.mjs](src/cli/save-inflight.mjs) | `save-inflight` — stdin の Markdown を現行バトンの memo_text に書き込む (`/tl` 直後に Claude 自身が呼ぶ) |
| [src/token-monitor.mjs](src/token-monitor.mjs) | `monitor` — マルチセッション対応トークンモニター。`--diag` で TTY/columns/env を出力（描画不具合の切り分け用） |
| [src/sc-detail.mjs](src/sc-detail.mjs) | `/sc-detail <時刻>` スラッシュコマンド（[.claude/commands/sc-detail.md](.claude/commands/sc-detail.md) 経由） |

### スラッシュコマンド

| ファイル | 用途 |
|---|---|
| [.claude/commands/tl.md](.claude/commands/tl.md) | `/tl` — バトン設置 + Claude 自身に in-flight メモを `save-inflight` で書かせる |
| [.claude/commands/sc-detail.md](.claude/commands/sc-detail.md) | `/sc-detail <時刻>` — L2+L3 詳細取得 |

### テスト

| ファイル | 対象 |
|---|---|
| [src/baton.test.mjs](src/baton.test.mjs) | `writeBaton` / `consumeBaton` / `updateBatonMemo` / TTL 動作 / memo_text 永続化 |
| [src/session-merger.test.mjs](src/session-merger.test.mjs) | `resolveMergeTarget` / `mergeSpecificPredecessor` |
| [src/state-file.test.mjs](src/state-file.test.mjs) | `writeSessionState` / `readAllSessionStates` / `snapshotStateMtimes` / stale 閾値 / `usage` スナップショット / 旧フォーマット互換 |
| [src/turn-processor.test.mjs](src/turn-processor.test.mjs) | `countDistinctBodyTurns` / `pickOldestUnsummarizedTurn` / 20 ターン境界。※ `main()` が stdin 待ちでテストファイル自体は 10s タイムアウトする（既存の既知問題、個別ケース 9/9 は pass）|
| [src/token-monitor.test.mjs](src/token-monitor.test.mjs) | CLI 引数、cell 幅、bar/色覚マーカー、`formatTimeAgo`、`shouldForceFullRedraw`、`formatLine` の ago 配置 |
| [src/transcript-reader.test.mjs](src/transcript-reader.test.mjs) | transcript JSONL パーサー、`extractDetailBlocks` の全 kind 分類 |
| [src/transcript-usage.test.mjs](src/transcript-usage.test.mjs) | `readLatestUsage` / `inferContextWindowSize` / 1M sticky / size+mtime キャッシュ |
| [src/vscode-task.test.mjs](src/vscode-task.test.mjs) | `ensureMonitorTaskFile` の全分岐 (created / merged / already_present / skipped×複数 reason)、JSONC 検出、インデント保持、冪等性 |
| [src/terminal-size.test.mjs](src/terminal-size.test.mjs) | `parseSizeResponse` / `startSizeQuery` — OSC 18t 応答パース、raw mode 遷移、分割到着、Ctrl+C 捕捉、stop() 冪等性 |
| [src/cli/doctor.test.mjs](src/cli/doctor.test.mjs) | `doctor --session` 用の `parseArgs` / `formatAgo` / `formatBytes` / `isPidAlive` / `findLatestJsonlInSameDir` |

```bash
# 個別ファイル推奨（turn-processor.test.mjs を含める場合 10 秒待つ）
node --test src/baton.test.mjs src/session-merger.test.mjs src/state-file.test.mjs \
            src/token-monitor.test.mjs src/transcript-reader.test.mjs src/transcript-usage.test.mjs \
            src/vscode-task.test.mjs src/terminal-size.test.mjs src/cli/doctor.test.mjs
```

### 削除済み

`src/classifier.mjs`, `src/detail-capture.mjs`, `src/throughline.mjs` は schema v4 で不要化して削除済み。`src/context-injector.mjs` は SessionStart との重複注入を解消するため廃止。CLAUDE.md や docs の旧記述に残っていたら現状と乖離しているサイン。

---

## Hooks 構成（現状）

`throughline install` が `~/.claude/settings.json` に書く内容は [src/cli/install.mjs](src/cli/install.mjs) の `SC_HOOKS` が正。

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "command": "throughline session-start" }] }],
    "Stop":             [{ "hooks": [{ "command": "throughline process-turn" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "command": "throughline prompt-submit" }] }]
  }
}
```

- **UserPromptSubmit** は `/tl` バトン書き込み専用。注入は一切しない（SessionStart 側との重複注入回避のため）
- **PostToolUse** は登録しない（schema v4 で廃止）
- **PreCompact** は使っていない（自動コンパクト依存の設計を放棄したため）
- dev 時に spike 系 hook（`spike/hook-logger.mjs` 等）が並行登録されている場合があるが、動作ログ採取用で実害なし

---

## SQLite スキーマ (v7)

`~/.throughline/throughline.db`（WAL モード）。schema migration の定義は [src/db.mjs](src/db.mjs) にあるので **スキーマを知りたい時は必ずそこを見る**。

主要テーブル:

- `sessions` — `session_id`, `project_path`, `status`, `created_at`, `updated_at`, `merged_into`
- `skeletons` (L1) — `session_id`, `origin_session_id`, `turn_number`, `role`, `summary`, `created_at`
- `bodies` (L2) — `session_id`, `origin_session_id`, `turn_number`, `role`, `text`, `token_count`, `created_at`
- `details` (L3) — `session_id`, `origin_session_id`, `turn_number`, `tool_name`, `input_text`, `output_text`, `token_count`, `created_at`, `kind`, `source_id`
  - `kind`: `'tool_input' | 'tool_output' | 'system' | 'image' | 'thinking'`
  - `source_id`: `tool_use.id` / `attachment.uuid` / `${entry_uuid}:thinking:${idx}` 等の一意キー。`INSERT OR IGNORE` の冪等性を保証
- `handoff_batons` (v7) — `project_path (PK)`, `session_id`, `created_at`, `memo_text` — `/tl` で書き込み、直後に `save-inflight` で memo_text が付与される。SessionStart が TTL 1h 以内なら消費して merge
- `injection_log` — 監査用（未活用）

`judgments` テーブルは v4 で DROP 済み。`classifier.mjs` による抽出は精度が低く廃止。

---

## 開発コマンド

```bash
# hooks セットアップ（このリポジトリだけに限定）
node bin/throughline.mjs install --project

# hooks 削除
node bin/throughline.mjs uninstall --project

# テスト（turn-processor.test.mjs は main() stdin 待ちで 10s タイムアウトする既知問題のため除外）
node --test src/baton.test.mjs src/session-merger.test.mjs src/state-file.test.mjs \
            src/token-monitor.test.mjs src/transcript-reader.test.mjs src/transcript-usage.test.mjs \
            src/vscode-task.test.mjs src/terminal-size.test.mjs src/cli/doctor.test.mjs

# モニター（別ターミナルで常駐、VSCode タスクが自動起動するので通常は手動不要）
node src/token-monitor.mjs

# 特定セッションの診断（モニターが止まって見える時の切り分け）
node bin/throughline.mjs doctor --session <id-prefix>

# DB 統計
node bin/throughline.mjs status

# DB を直接覗く
node --input-type=module <<'EOF'
import { getDb } from './src/db.mjs';
const db = getDb();
console.log(db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 5').all());
EOF
```

---

## 技術スタック

- **ランタイム**: Node.js v22.5+、ESM（`.mjs` 統一）
- **データベース**: `node:sqlite`（Node.js 組み込み、同期 API）
- **外部依存**: なし
- **対応プラットフォーム**: Windows、Linux、macOS
- **Haiku 要約**: `claude -p --model claude-haiku-4-5-20251001`（Claude Max 契約の認証を使う、API キー不要）

---

## 作業上の規律

- **設計書と実装が食い違っていたら、どちらかが古い**。まずソースを確認する。ソースが正。設計書を更新する
- **進捗を docs に残す**。計画書のチェックボックスと README / CLAUDE.md のステータス行を同時に更新する
- **新しい .md ファイルを作る前に、既存ファイルに追記できないか考える**。docs フォルダが肥大化する原因はほぼこれ
- **破棄された設計は `docs/archive/` に移動**。現行 docs と歴史記述を同じ階層に混在させない
