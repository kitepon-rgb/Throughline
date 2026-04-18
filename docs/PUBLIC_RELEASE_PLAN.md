# Throughline 公開配布化プラン

## §0 プロジェクト不変ルール

**フォールバック / 逃げ道のコードを書かない。** バグを隠してデバッグを困難にするため、想定外の状態・契約違反・依存関係の不在などに遭遇した場合は **エラーを吐いて停止** する。該当箇所を後で直すのが正しい対応。

具体的には以下のパターンを禁止する:

- `try { ... } catch { /* ignore */ }`（例外を黙って握り潰す）
- `catch (err) { stderr.write(...); process.exit(0); }`（エラーを記録しつつ成功コードで終わる）
- 「A がダメなら B」という暗黙の切り替え（明示的な設定フラグなしでの挙動分岐）
- 未検証の契約に対する「とりあえず動く」実装

例外は以下のみ:
- 外部入力のバリデーション失敗 → 明確な `throw new Error(...)` で拒否
- hook 実行での I/O エラー → stderr + 非ゼロ終了コード（Claude Code 側で可視化される）
- 既に値が NULL であることが設計上許容されている場合の `?.` アクセス

---

## ゴール

Throughline を GitHub + npm で公開し、世界中の Claude Code ユーザーに使ってもらう。満たすべき条件:

1. **導入が簡単** — 1〜2 コマンドで完了
2. **複数プロジェクトで動く** — 導入後は全プロジェクトで自動的に働く
3. **絶対パス依存を避ける** — 環境差（Windows / macOS / Linux、node のインストール先）で壊れない

---

## 採用方式: npm グローバル + bin エントリ

### 導入フロー（ユーザー視点）

```bash
npm install -g throughline     # CLI を PATH に配置
throughline install            # ~/.claude/settings.json に hook を追記
```

hook コマンドは **`throughline <subcommand>` の PATH 解決型**。node のインストール先や OS が変わっても PATH さえ通っていれば動く。

### hook 登録後の `~/.claude/settings.json`（抜粋）

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "command": "throughline session-start" }] }],
    "Stop":         [{ "hooks": [{ "command": "throughline process-turn" }] }]
  }
}
```

schema v4 で PostToolUse (`capture-tool`) は廃止、L2/L3 は Stop 内で一括処理。schema v6 で UserPromptSubmit (`prompt-submit`) を `/tl` バトン書き込み専用として再導入（注入は一切行わない、SessionStart 側との重複注入は発生しない）。schema v7 で `handoff_batons.memo_text` を追加（`/tl` 直後に in-flight メモを保存）。

### 却下した代替案

- **npx (`npx -y throughline <subcommand>`)**: hook 発火ごとに npx のオーバーヘッドが乗り、UX が悪化する
- **絶対パスを install 時に解決** (`node C:\Users\...\src\...`): リポジトリを移動すると壊れる
- **Claude Code プラグインマーケットプレース形式**: まず npm で出してから将来 ECC 等に登録する

---

## 実装ステータス

### ✅ 実装済み

| 項目 | 実体 |
|---|---|
| CLI エントリポイント | [bin/throughline.mjs](../bin/throughline.mjs) |
| package.json（`bin`, `files`, `engines`, `keywords`, `repository`, `license`） | [package.json](../package.json) |
| install / uninstall コマンド（デフォルト global、`--project` でローカル） | [src/cli/install.mjs](../src/cli/install.mjs) |
| doctor サブコマンド | [src/cli/doctor.mjs](../src/cli/doctor.mjs) |
| status サブコマンド（sessions / skeletons / bodies / details 件数） | [src/cli/status.mjs](../src/cli/status.mjs) |
| monitor サブコマンド（マルチセッション対応） | [src/token-monitor.mjs](../src/token-monitor.mjs) |
| 状態ファイルをセッション単位に分割 | [src/state-file.mjs](../src/state-file.mjs) |
| transcript JSONL から実測 usage 抽出、1M context 検出 | [src/transcript-usage.mjs](../src/transcript-usage.mjs) |
| 記憶張り替え方式（merged_into + origin_session_id, schema v3） | [src/session-merger.mjs](../src/session-merger.mjs) |
| schema v4 migration（bodies 追加、judgments DROP） | [src/db.mjs](../src/db.mjs) |
| schema v5 migration（details に kind / source_id 追加、L3 分離書き込み対応） | [src/db.mjs](../src/db.mjs) |
| schema v6 migration（handoff_batons テーブル追加、`/tl` バトン引き継ぎ方式） | [src/db.mjs](../src/db.mjs), [src/baton.mjs](../src/baton.mjs) |
| schema v7 migration（`handoff_batons.memo_text` カラム追加、in-flight メモ保存） | [src/db.mjs](../src/db.mjs), [src/baton.mjs](../src/baton.mjs), [src/cli/save-inflight.mjs](../src/cli/save-inflight.mjs) |
| VSCode `.vscode/tasks.json` の自動プロビジョニング（token-monitor の folderOpen 自動起動） | [src/vscode-task.mjs](../src/vscode-task.mjs) |
| Stop フック時の state.usage スナップショット（monitor の「止まって見える」問題の切り分け用） | [src/state-file.mjs](../src/state-file.mjs), [src/turn-processor.mjs](../src/turn-processor.mjs) |
| `throughline doctor --session <id-prefix>` セッション診断（state/transcript ズレ検出） | [src/cli/doctor.mjs](../src/cli/doctor.mjs) |
| token-monitor の `(Nm ago)` 表示 + columns polling による resize 検知 | [src/token-monitor.mjs](../src/token-monitor.mjs) |
| token-monitor の OSC 18t による端末実幅取得 (Windows ConPTY + VSCode task の resize 追従) | [src/terminal-size.mjs](../src/terminal-size.mjs), [src/token-monitor.mjs](../src/token-monitor.mjs) |
| token-monitor の `--diag` サブモード (TTY/columns/env の実測出力、`~/.throughline/last-diag.txt` にも保存) | [src/token-monitor.mjs](../src/token-monitor.mjs) |
| `/tl` スラッシュコマンド + UserPromptSubmit hook でバトン書き込み | [.claude/commands/tl.md](../.claude/commands/tl.md), [src/prompt-submit.mjs](../src/prompt-submit.mjs) |
| SessionStart でバトン消費 → 指名 merge（自動推測の引き継ぎは撤去） | [src/session-start.mjs](../src/session-start.mjs), [src/session-merger.mjs](../src/session-merger.mjs) |
| L3 ブロック分類抽出（tool_use / tool_result / attachment hook / thinking 破棄） | [src/transcript-reader.mjs](../src/transcript-reader.mjs) |
| L3 書き込み（Stop フック内で bodies/skeletons と同時に details に INSERT OR IGNORE） | [src/turn-processor.mjs](../src/turn-processor.mjs) |
| /sc-detail コマンドの kind 別グループ表示 | [src/sc-detail.mjs](../src/sc-detail.mjs) |
| Haiku 4.5 同期要約（subprocess 再帰ガードつき） | [src/haiku-summarizer.mjs](../src/haiku-summarizer.mjs) |
| L1/L2 書き込み（Stop フック内で一括処理） | [src/turn-processor.mjs](../src/turn-processor.mjs) |
| 遅延 Haiku 要約（20 ターン以内はコストゼロ） | [src/turn-processor.mjs](../src/turn-processor.mjs) |
| README（schema v7 対応版、VSCode 自動起動・モニター診断機能を記載） | [../README.md](../README.md) |
| LICENSE | [../LICENSE](../LICENSE) (MIT) |
| token-monitor 折り返し対策（ANSI 幅切り詰め） | [src/token-monitor.mjs](../src/token-monitor.mjs) |
| § 0 ルール適用（silent try/catch 掃除） | 主要ファイルすべて |
| **`npm pack --dry-run` 検証** | 2026-04-17 確認、23 ファイル / 38.3 KB、秘密情報なし |
| **npm 公開 (v0.1.0)** | 2026-04-17 https://www.npmjs.com/package/throughline に publish 済み |
| **npm 公開 (v0.2.0)** | 2026-04-18 バトン方式引き継ぎ (schema v6) を publish |
| **npm 公開 (v0.3.0)** | 2026-04-18 in-flight メモ + thinking L3 + resume reframing (schema v7) を publish |
| **npm 公開 (v0.3.1 〜 v0.3.2)** | 2026-04-18 monitor の描画・クラッシュ耐性・1M context 検出の精度向上、色覚配慮マーカー |
| **npm 公開 (v0.3.3)** | 2026-04-18 `.vscode/tasks.json` 自動プロビジョニングを publish（2 段階マージ方式、JSONC 検出） |
| **npm 公開 (v0.3.4 〜 v0.3.5)** | 2026-04-18 Stop 時 state.usage 固定、`doctor --session` 診断、`(Nm ago)` 表示、columns polling で resize 検知 |
| **npm 公開 (v0.3.6 〜 v0.3.12)** | 2026-04-18 monitor 描画の「行が積み上がる」バグ対策の連続試行 (columns フォールバック、isTTY 切分け、clearScreen、alt screen、type:shell 等)。いずれも憶測ベースで的外れ。`--diag` モードを 0.3.11 で追加して実測に切替 |
| **npm 公開 (v0.3.13)** | 2026-04-18 真因修正: resolveColumns の `>= 40` 閾値撤廃。実在する 30 セル panel を「狂った値」と誤判定して 200 にフォールバックし wrap → CUU under-count → 積み上がり、という連鎖を解消 |
| **npm 公開 (v0.3.14 〜 v0.3.15)** | 2026-04-18 追加の診断出力 (起動ヘッダ、per-frame cols 表示)。panel resize に Node の `process.stdout.columns` が追従しないことを実機で確定 |
| **npm 公開 (v0.3.16)** | 2026-04-18 OSC 18t (`\x1b[18t`) クエリで端末から実幅を直接取得。Windows ConPTY + VSCode task terminal の resize 不追従を回避。[src/terminal-size.mjs](../src/terminal-size.mjs) 新設 |
| **npm 公開 (v0.3.17)** | 2026-04-18 resize 検知時の強制再描画で `ANSI.clearScreen` を明示発行するよう修正（前フレームが残って新フレームが下に積まれる最後のバグを潰した）|
| **グローバル E2E 検証** | 2026-04-17 別ディレクトリから `throughline doctor` 全緑を確認 |

### ❌ 未完タスク

| 項目 | 備考 |
|---|---|
| **awesome-claude-code 登録申請** | 初回 public commit から 1 週間経過（2026-04-21 以降）に Web UI 経由で提出 |
| **外部環境での実運用検証** | 別 PC / OS での install、並行 `/clear` 時の merge chain 挙動、1M context 検出のロバストさ、VSCode 系以外のエディタでの token-monitor 挙動、macOS / Linux で OSC 18t がフォールバック経路と実幅取得の両方で正しく動くかの確認 |
| **GitHub Actions 自動 publish** | `release` タグ push をトリガー（Phase 3+、Trusted Publishing 使用） |
| **Claude Code プラグインマーケットプレース登録** | npm 公開の後継ステップ（Phase 3+） |
| **turn-processor.test.mjs の 10 秒タイムアウト解消** | `main()` が stdin を待ち続けるためテストファイルがハングする既存の問題。実装動作は無影響、テスト個別 9/9 は pass |

---

## 検証方法（End-to-End）

初回 publish（v0.1.0 / 2026-04-17）は以下の実行で確認済み:

1. `npm pack --dry-run` で tarball 内容を確認（23 ファイル、秘密情報なし）
2. `npm publish` 実行 → `+ throughline@0.1.0`
3. `npm view throughline` でレジストリに反映されていることを確認
4. 別ディレクトリで `npm install -g throughline` → `throughline install` → `throughline doctor` 全緑
5. `~/.claude/settings.json` の hook が global スコープに登録されていることを確認

次バージョン以降は次の手順で：

```bash
# 版上げ（例: patch）
npm version patch

# publish（granular access token with bypass 2FA を使う場合は OTP 不要）
npm publish

# 反映確認
npm view throughline
npm install -g throughline
throughline doctor
```

さらに別環境（macOS / Linux / 別 PC）での claude 起動・並行 `/clear` 挙動・1M context 検出のロバストさは未検証。

---

## スコープ外（別 Phase）

- GitHub Actions による自動リリース（Trusted Publishing 推奨）
- `injection_log` 効果測定
- Claude Code プラグインマーケットプレース登録（Phase 3+）
