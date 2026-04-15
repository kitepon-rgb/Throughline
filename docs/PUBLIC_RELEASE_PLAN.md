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
    "SessionStart":     [{ "hooks": [{ "command": "throughline session-start" }] }],
    "Stop":             [{ "hooks": [{ "command": "throughline process-turn" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "command": "throughline inject-context" }] }]
  }
}
```

schema v4 では PostToolUse (`capture-tool`) は廃止。L2/L3 は Stop 内で一括処理する（L3 書き込みは計画書ステップ 4 未完、[L1_L2_L3_REDESIGN.md](L1_L2_L3_REDESIGN.md) 参照）。

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
| Haiku 4.5 同期要約（subprocess 再帰ガードつき） | [src/haiku-summarizer.mjs](../src/haiku-summarizer.mjs) |
| L1/L2 書き込み（Stop フック内で一括処理） | [src/turn-processor.mjs](../src/turn-processor.mjs) |
| 遅延 Haiku 要約（20 ターン以内はコストゼロ） | [src/turn-processor.mjs](../src/turn-processor.mjs) |
| README（schema v4 対応版） | [../README.md](../README.md) |
| LICENSE | [../LICENSE](../LICENSE) (MIT) |
| token-monitor 折り返し対策（ANSI 幅切り詰め） | [src/token-monitor.mjs](../src/token-monitor.mjs) |
| § 0 ルール適用（silent try/catch 掃除） | 主要ファイルすべて |

### ❌ 未完タスク

| 項目 | 備考 |
|---|---|
| **L3 (details) 書き込みパス実装** | [L1_L2_L3_REDESIGN.md](L1_L2_L3_REDESIGN.md) のステップ 4 残り。`tool_use` / `tool_result` / `system` / `image` のブロック分類、ノイズ除去、`thinking` 破棄、`details.kind` 列追加 |
| **CLAUDE.md / docs の現行化** | 一部反映済みだが、ステップ 4 完了後に再度見直し |
| **`npm pack --dry-run` 検証** | tarball 内容確認、秘密情報の混入チェック |
| **`npm link` による E2E 検証** | 別プロジェクトで install → 1〜2 ターン会話 → `doctor` 緑 → `uninstall` クリーンの流れ |
| **npm publish** | 本番リリース（`throughline` 名の空き確認含む） |
| **GitHub Actions 自動 publish** | `release` タグ push をトリガー（Phase 3+） |

---

## 検証方法（End-to-End、未実施）

1. ローカルで `npm link` して CLI を PATH に通す
   ```bash
   cd Throughline
   npm link
   throughline --version
   ```

2. 自プロジェクト以外のディレクトリに移動
   ```bash
   mkdir ~/tmp-test-project && cd ~/tmp-test-project
   ```

3. `throughline install` で `~/.claude/settings.json` に hook が書かれていることを確認

4. そのディレクトリで `claude` を起動し、1〜2 ターン会話
   - 全 hook がエラーなく発火するか確認
   - `/clear` 後に引き継ぎヘッダが表示されるか確認
   - バナーなしの新規 `claude` 起動で汚染がないことを確認

5. DB を直接確認: `project_path` が正しいディレクトリになっていること

6. `throughline doctor` で全チェックが緑になるか

7. `throughline uninstall` で Throughline 行だけがクリーンに消えること

8. `npm pack --dry-run` で秘密情報・不要ファイルが含まれていないか確認

---

## スコープ外（別 Phase）

- npm への実 publish
- GitHub Actions による自動リリース
- `injection_log` 効果測定
- Claude Code プラグインマーケットプレース登録（Phase 3+）
