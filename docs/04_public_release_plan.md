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
3. **配布物の絶対パス依存を避ける** — npm tarball に開発環境の path を焼き込まず、install 時に必要な実行 path だけをユーザー環境で解決する

---

## 採用方式: npm グローバル + bin エントリ

### 導入フロー（ユーザー視点）

```bash
npm install -g throughline     # CLI を PATH に配置
throughline install            # ~/.claude/settings.json、Codex hook、Codex skill を追記
```

Claude hook コマンドは **`throughline <subcommand>` の PATH 解決型**。node のインストール先や OS が変わっても PATH さえ通っていれば動く。Codex Stop hook は Codex App Server / VSCode host の PATH 差分を避けるため、絶対 node + installed `bin/throughline.mjs` で登録する。Codex 手動 UX は `~/.codex/skills/throughline` の `$throughline` skill で自然言語から呼ぶ。

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
- **Claude hook を開発リポジトリの絶対パスで登録** (`node C:\Users\...\src\...`): リポジトリを移動すると壊れる。Codex Stop hook だけは App Server / VSCode host の PATH 差分を避けるため、install 時点の installed CLI script path を絶対 node で登録する
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
| schema v7 migration（`handoff_batons.memo_text` カラム追加、in-flight メモ保存） | (v8 で memo_text drop、save-inflight 削除済み) |
| schema v8 migration（`handoff_batons.memo_text` drop、`/clear` auto path 化、`save-inflight` / `/tl-trim` / `updateBatonMemo` 削除、注入を L1+L2+L3 refs のみに簡素化） | [src/db.mjs](../src/db.mjs), [src/session-start.mjs](../src/session-start.mjs), [src/resume-context.mjs](../src/resume-context.mjs), [docs/02_clear_auto_handoff_plan.md](02_clear_auto_handoff_plan.md) |
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
| **npm 公開 (v0.3.18)** | 2026-04-18 `ensureMonitorTaskFile` を Stop に加え **SessionStart / UserPromptSubmit でも呼ぶ** ように変更。別プロジェクトで Stop hook が発火しなかった実機例で tasks.json が生成されない問題に対応。どれか 1 つの hook が発火すれば tasks.json が作られる冗長化 |
| **npm 公開 (v0.3.19)** | 2026-04-18 tasks.json を新規作成/マージした瞬間に `<system-reminder>` を stdout へ出力し、Claude 経由で「Reload Window が必要」をユーザーへ即時通知。`already_present` では沈黙（1 プロジェクト 1 回だけ） |
| **npm 公開 (v0.3.20)** | 2026-04-19 monitor の context 枯渇警告を `/clear` ではなく `/tl` 推奨に修正（引き継ぎを壊さない案内へ統一） |
| **npm 公開 (v0.3.21)** | 2026-04-19 `throughline install` が `/tl` と `/sc-detail` スラッシュコマンド定義 (`~/.claude/commands/*.md`) をグローバル配置するように変更。プロジェクト個別の `.claude/commands/` 依存を廃止 |
| **npm 公開 (v0.3.22)** | 2026-04-19 Stop hook を `"async": true` で登録。`throughline process-turn`（内部で Haiku subprocess 起動）がターン完了 → ユーザー表示をブロックしていた症状を解消。L1 要約は次 SessionStart 注入用なので今ターンをブロックする理由が無い。既存ユーザーは `throughline uninstall && throughline install` で再登録が必要（dedup が command 一致で skip するため async フラグ昇格は起きない）。Claude Code 公式 hooks schema の正式フィールドであることを docs で確認済み |
| **npm 公開 (v0.3.23)** | 2026-05-02 クロス環境ユーザビリティの 2 件: (1) `.vscode/tasks.json` の **絶対パス自動修復** — Windows ↔ WSL2 / Linux ↔ macOS 間でリポジトリを共有したとき、別環境の絶対パスが焼き込まれた既存タスクを検出して `command` / `args` だけを差し替え、`label` / `presentation` 等のユーザーカスタマイズは保持。`isMonitorTaskBroken` (絶対パス + 非存在で判定) と `findMonitorTaskIndex` を [src/vscode-task.mjs](../src/vscode-task.mjs) に新設。`action: 'repaired'` を追加して Reload Window 通知を 1 回出す。(2) `throughline install` 完了時に **PATH 解決チェック** — `resolveThroughlineOnPath` が PATH を走査して `throughline` が見つからない場合、stderr に修復手順 (npm prefix → `~/.bashrc` 編集 → `doctor` 確認) を出力。`~/.npm-global/bin` を `.profile` だけに書いて `.bashrc` に書き忘れる sudoless prefix 派の silent fail を防ぐ。あわせて [README.md](../README.md) Troubleshooting に WSL2 ↔ Windows 交差 / OS 別 DB / tasks.json 自動修復の各節を追加 |
| **npm 公開 (v0.3.24)** | 2026-05-02 v0.3.23 の補完: `.vscode/tasks.json` には現環境の絶対パスが書き込まれるため、**そもそも commit すべきではない**。`shouldRecommendGitignore` を [src/vscode-task.mjs](../src/vscode-task.mjs) に追加し、`ensureMonitorTaskFile` が created / merged / repaired を返すタイミングで「git リポジトリ内かつ `.gitignore` に `.vscode/tasks.json` 系エントリが無い」を判定。該当時に `<system-reminder>` で `.gitignore` 追加推奨を 1 度だけ stdout 通知 (`.throughline-gitignore-noted` marker で抑止)。否定パターン (`!.vscode/tasks.json`) はスキップ判定 = 推奨を出す。README Troubleshooting にも明示。配布物 (npm tarball) には絶対パスは入っていない (`files` フィールドが `.vscode/` を含まない、ソースに hard-coded path 無し) ことを再確認 |
| **npm 公開 (v0.3.25): Claude-primary / Codex-sidecar groundwork** | `HandoffRecord` projection、`throughline handoff-preview`、`throughline_handoff` example、`codex-sidecar-diagnostics` / `codex-sidecar-dry-run` を追加。Claude Code hooks / slash command / transcript / baton / resume behavior は正本として維持し、Codex 対応は adapter / projection として足す |
| **npm 公開 (v0.3.25): optional Codex-sidecar L1 summarization** | Claude primary の L2→L1 要約は、`codex-sidecar` が `summarize-l1` preset で configured の場合だけ sidecar を使う。disabled / unavailable / run failure では、ユーザー許可済み互換経路として既存 Claude Haiku 要約を維持する。Codex primary の L2→L1 backend は次フェーズ計画で Codex CLI 本線として扱う。Claude CLI smoke / test で Claude を呼ぶ場合は Haiku を使う |
| **npm 公開 (v0.3.25): `/tl-trim` dry-run** | `throughline trim --dry-run`、`--preflight`、guarded `--execute`、`--host`、`--keep-recent`、`--all`、`--memo-stdin`、`--preview-max-chars`、`--codex-thread-id`、`THROUGHLINE_CODEX_THREAD_ID` / `CODEX_THREAD_ID`、`throughline codex-threads`、`throughline doctor --trim`、Claude slash command `/tl-trim` を追加。Codex app-server の rollback / inject primitive は live app-server 上で実測済み。2026-05-06 incident 後は一時 blocked としたが、2026-05-08 の controlled rollback model-visible smoke が app-server restart 境界と VS Code reload/reconnect 境界の両方で `not-reproduced` だったため、過剰 blocker は解除済み。`trim --execute --host codex` は明示実行で current-thread rollback + Throughline DB memory inject を送り、Codex Stop hook auto-refresh は verified usage 75% 以上で同じ guarded path を試行する。DB memory 不在、Codex thread identity 不在、rollout/app-server turn-count 不一致は mutation 前に拒否する。restore-safety / planned restore-safety / host primitive audit は diagnostics として表示する |
| **npm 公開 (v0.3.25): Codex primary capture** | `throughline codex-capture --codex-thread-id <id>` を追加。Codex rollout JSONL の active turns を `codex:<thread_id>` session として DB `bodies` に保存し、`function_call` / `function_call_output` を DB `details` の L3 tool input / output として保存する。`thread_rolled_back` 適用後の active thread だけを再構成し、rollback 済み tail は current L2/L3 に残さない。Codex thread id は明示指定または env 指定のみで、自動推測しない |
| **npm 公開 (v0.3.25): Codex-primary L1 backend** | `summarizeToL1` に `hostMode` 分岐を追加。Claude primary は既存の `codex-sidecar` / Claude Haiku 互換経路を維持し、Codex primary は Codex CLI backend を使う。Codex CLI failure は `source = codex-cli` / `reason` 付き explicit error とし、Claude Haiku / `raw_l2` に silent fallback しない |
| **npm 公開 (v0.3.25): Codex-primary L1 CLI** | `throughline codex-summarize --session codex:<thread_id>` を追加。captured Codex L2 が L2 window を超えた場合、最古の未要約 turn を Codex CLI backend で L1 skeleton に書く。Codex CLI failure は explicit error |
| **npm 公開 (v0.3.25): Codex primary resume renderer** | `throughline codex-resume --session codex:<thread_id>` を追加。保存済み `codex:<thread_id>` memory を Active Work Thread / Reading Contract / Continuation Instruction 付きの Codex active-work context として描画する。`--format handoff` は新規 Codex thread に貼るための短い handoff prompt を返し、L2 件数 / 本文長 / detail refs を cap する。`throughline codex-handoff-smoke --session codex:<thread_id>` はその handoff prompt を read-only に検査し、fresh-thread header / current-task contract / source session / start instruction / mutation boundary / prompt size / detail command dedupe を確認する。`throughline codex-handoff-model-smoke --session codex:<thread_id>` は `--dry-run` で env なしに readiness / command boundary を監査でき、`--print-prompt` で結合 prompt を出せる。`throughline codex-handoff-start --session codex:<thread_id>` は structural smoke / model dry-run / render command / optional live smoke / `--print-prompt` を一つの guided read-only start plan として表示する。`--memo-stdin` は Codex-primary の in-flight memo を handoff prompt に含め、handoff-start は replay 用個別 command にも `--memo-stdin` を伝播する。live smoke は `THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1` がある場合だけ structural smoke 後に `codex exec --ephemeral --ignore-user-config --ignore-rules --sandbox read-only` で marker model smoke を行う。`--format item-json` は developer message item JSON を返す。renderer は DB / Codex thread を mutate しない |
| **npm 公開 (v0.3.25): Codex model-visible smoke** | `throughline codex-visibility-smoke --session codex:<thread_id>` を追加。`codex-resume` 相当の active-work developer message に marker 指示を加えて app-server `thread/inject_items` へ送り、`turn/start` の agent delta に marker が出るか確認する。`--memo-stdin` で同じ in-flight memo surface を実注入できる。`--resume-after-inject` で inject 後に再度 `thread/resume` してから marker turn を開始できる。実 model turn を開始するため `THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE=1` が必須。実 Codex host で marker `TL_CODEX_VISIBLE_REAL_20260506_C` と post-inject resume marker `TL_CODEX_RESUME_AFTER_INJECT_REAL_20260506` が `item/agentMessage/delta` に出ることを確認済みで、長い model turn 用に `--request-timeout-ms` / `--timeout-ms` を持つ |
| **npm 公開 (v0.3.25): Codex app-server restore smoke** | `throughline codex-restore-smoke --codex-thread-id <id>` を追加。fresh Codex app-server process を複数回起動し、`thread/read` / `thread/resume` / paginated `thread/turns/list` の turn count が rollout active turn count と一致し続けるかを read-only で確認する。`THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE=1` 必須。proof scope は `app_server_process_restart_only` で、VS Code restart / reconnect 越しの rollback / inject durability 証明ではない |
| **npm 公開 (v0.3.25): Codex restore source audit** | `throughline codex-restore-source-audit --codex-thread-id <id>` を追加。Codex rollout、`session_index.jsonl`、`state_*.sqlite`、VS Code globalStorage / workspaceStorage 候補、VS Code settings / logs、installed OpenAI/Codex VS Code extension bundle を read-only で棚卸しし、thread id、retained rollback text、`thread/read` / `thread/resume` / `thread/turns/list` / reconnect `needs_resume` / persisted webview atoms / follow-up queue などの restore-path signal を確認する。proof scope は `local_restore_source_inventory_only` で、VS Code restart / reconnect 越しの rollback / inject durability 証明ではない |
| **npm 公開 (v0.3.25): Codex host primitive audit** | `throughline codex-host-primitive-audit` を追加。installed Codex CLI の app-server JSON schema を read-only 生成し、rollback 済み user text を同じ thread の model-visible input に復活させない deletion / isolation / projection primitive があるか機械判定する。実 `codex-cli 0.128.0-alpha.1` では `thread/rollback` / `thread/inject_items` / `thread/compact/start` / `thread/start` / `thread/fork` / `thread/resume` は存在したが、current-thread rollback non-resurrection primitive は無く、`thread/resume(history)` も unstable do-not-use かつ thread_id ignored なので採用しない。結果は diagnostic-only で、Codex trim execute / auto-refresh の blocker にはしない |
| **npm 公開 (v0.3.25): Codex VS Code restore smoke protocol** | `throughline codex-vscode-restore-smoke --prepare/--verify --codex-thread-id <id>` を追加。`--prepare` は hidden active-work marker memory を app-server へ注入し、VS Code reload / reconnect 後に marker を含まない prompt を送る二段階手順を出す。`--verify` は rollout を読み、prepare 後の marker-free smoke prompt、assistant の marker-only answer、user prompt への marker leak 不在を確認する。prepare は `THROUGHLINE_EXPERIMENTAL_CODEX_VSCODE_RESTORE_SMOKE=1` 必須。実 VS Code reload / reconnect marker proof は `TL_CODEX_VSCODE_RESTORE_46888202` で成功済み。ただしこれは hidden developer memory visibility 証明であり、rollback 済み user turn の非復活証明ではない |
| **npm 公開 (v0.3.25): Codex VS Code rollback smoke verifier** | `throughline codex-vscode-rollback-smoke --verify --codex-thread-id <id>` を追加。rollout を read-only で読み、rollback event、rollback 済み user text、rollback 後 user turn、`restoreSafety.status = ok` を必須条件にする。`--after-vscode-restart` がある場合だけ `restartSafe: true` を返す。実 incident-shaped live rollback run では `thread_rolled_back` と injected memory は記録されたが、rollback 対象 user text が `compacted.replacement_history` に残り、後続 verifier では rollback 済み user text の再出現も観測した。後続分類で app-server response 上の retained text は `aggregatedOutput` に限定され、controlled rollback model-visible smoke は再現しなかったため、これは現在は diagnostic evidence として扱う |
| **npm 公開 (v0.3.25): Codex primary doctor** | `throughline doctor --codex` を追加。現在 project の Codex thread env identity、rollout candidates、captured `codex:<thread_id>` DB sessions、context-refresh memory contract、new-thread handoff readiness、safe continuation status、host primitive audit status、次に使う capture / handoff / resume / audit command を表示する。doctor 自体は read-only で、Codex thread / DB / Claude settings を変更しない。`doctor --trim --host codex` も host primitive audit status を表示する |
| **npm 公開 (v0.3.25): Codex global Stop hook / skill install** | `throughline install` が Claude hooks / slash commands に加えて `~/.codex/hooks.json` に絶対 node + installed `bin/throughline.mjs codex-hook stop` を `async: false` で登録し、`~/.codex/config.toml` の `[features].codex_hooks = true` を有効化し、`~/.codex/skills/throughline` に `$throughline` skill を配置する。Codex App Server / VSCode host の PATH 差分で bare `throughline` が見えない可能性があるため、hook は Caveat と同じ絶対パス型に寄せる。既存 Caveat / Spotter などの Codex hooks は保持し、`throughline uninstall` は Throughline 管理の Codex hook / skill だけを削除する。既に bare command または `async: true` で登録済みの Throughline Codex Stop hook は次回 install で更新する。実環境では `codex exec --json` child thread `019dfd4f-93ff-7522-8f89-bd1e1996c8d7` が Stop hook で自然 capture され、`doctor --codex` の latest DB session が `codex:019dfd4f-93ff-7522-8f89-bd1e1996c8d7` に進むことを確認した。さらに絶対パス型へ更新後、child thread `019dfd5e-1248-7c11-8ddc-97e1b0701e10` でも latest DB session が `codex:019dfd5e-1248-7c11-8ddc-97e1b0701e10` に進むことを確認した。hook shape 変更後に新規開始した VSCode-origin thread `019dfd62-9a9d-7211-bf91-89d8e3fc908e` でも `doctor --codex` の current thread と latest DB session が一致し、自然 Stop hook capture を確認済み。hook shape 変更前から開いていた VSCode-origin parent thread は、変更後の自然 Stop smoke としては扱わない。Caveat 側にも `async: false` Stop hook が動く実測があるため、Codex 側は Caveat と同じ同期 hook 方針に寄せる。`codex-capture` / `codex-summarize` / `codex-resume --memo-stdin` は診断・明示操作 surface として維持し、model-visible smoke は明示 opt-in。2026-05-08 以降、Stop hook auto-refresh は verified usage 75% 以上で guarded rollback / inject を試行し、estimate usage では mutation しない。2026-05-09 以降は Codex native auto-compact より先に Throughline refresh を走らせつつ、70% warning よりは mutation を遅らせる |
| **npm 公開 (v0.3.25): Codex-first roadmap** | [05_codex_first_roadmap.md](05_codex_first_roadmap.md) を追加。次フェーズは Codex primary 実用化、Codex Rewind 互換、Claude 側 finalization の順で進める。Codex primary の L2→L1 backend は Codex CLI を本線とし、`codex-sidecar` は Claude primary からの review / risk-check / second opinion / 互換 L2→L1 経路として整理する |
| **npm 公開 (v0.3.25): npm docs packaging** | README から参照する `docs/` と `CHANGELOG.md` を npm `files` に追加。`docs/throughline-handoff-context.example.json` を含め、README の sidecar dry-run 例が tarball 内でも成立するようにする |
| **npm 公開 (v0.4.0): /clear auto-handoff + memo / save-inflight / /tl-trim retire** | 2026-05-08 Claude Code 2.1.128 で `source='clear'` が reliable になったため、`/clear` で自動引継ぎがデフォルト ON になる auto path を追加。`THROUGHLINE_DISABLE_AUTO_HANDOFF=1` で OFF にできる。`/tl` slash command は明示意思マーカーへ簡素化 (memo 4 項目入力廃止、`save-inflight` CLI 削除、`/tl-trim` slash command 廃止、`updateBatonMemo` 関数削除、`handoff_batons.memo_text` を schema v8 で drop)。注入は L1 + L2 + L3 references のみに簡素化し、memo / 中断直前 thinking セクションを削除。Codex 側 trim path は維持。詳細は [CHANGELOG.md](../CHANGELOG.md) と [02_clear_auto_handoff_plan.md](02_clear_auto_handoff_plan.md) |
| **npm 公開 (v0.4.1): typed `/clear` も baton を書く + 2 経路の優先順位入れ替え** | 2026-05-09 `/clear` を UserPromptSubmit hook で検出した時点で当該セッションの `session_id` を `handoff_batons` に書き込み、次 SessionStart が確定的にそのセッションを引き継ぐ。これで multi-window で「最新更新セッション ≠ /clear したセッション」になるシナリオで `findLatestClaudePredecessor` heuristic が誤った前任を選ぶ問題を解消。2 経路の優先順位を **baton path = primary、auto path = fallback** に変更 (auto path は VSCode 拡張メニュー由来など UserPromptSubmit に届かない経路のフォールバック)。`THROUGHLINE_DISABLE_AUTO_HANDOFF=1` は fallback path のみに作用するようになった (typed `/clear` / `/tl` は env と無関係に発火する)。あわせて `.vscode/tasks.json` を git 追跡から外し (gitignore)、`ensureMonitorTaskFile` が hook 発火ごとに絶対パスを書き換える挙動による別環境での dirty diff を解消。`src/prompt-submit.test.mjs` を新設し、`isClearCommand` / `isBatonCommand` 判定 14 件と subprocess+DB 実体テスト 3 件を追加。詳細は [CHANGELOG.md](../CHANGELOG.md) |
| **npm 公開 (v0.4.7): Codex monitor direct discovery + 80% auto-refresh** | 2026-05-09 Codex Stop hook auto-refresh の verified usage threshold を 90% から 80% に変更し、Codex native auto-compact より先に Throughline DB memory refresh を試行する。estimate usage / estimated context window では mutation しない。`throughline monitor` は `~/.throughline/state` に加えて `~/.codex/sessions/**/rollout-*.jsonl` を直接 discovery し、Throughline state が未生成の現在 Codex thread も表示する。既存 state がある場合は state の usage snapshot を保持しつつ discovered rollout path / mtime を合流する。Codex 表示 ID は `codex:01` ではなく raw thread id 先頭 8 桁 (`019e085c`) にした。Codex open turn の transient `output_tokens` は token count に overlay するが、モデル欄の `live+<tokens>` marker は表示しない |
| **未リリース: Codex current-session 75% trigger** | Codex 自動発火を token-monitor に依存させず、global install が Codex `UserPromptSubmit` / `PostToolUse` hooks も登録する。hook は当該 Codex session の rollout `token_count` を直接読み、verified 75% 以上なら同じ user turn または tool loop 継続前に `$throughline` workflow 実行指示を `additionalContext` で注入する。Stop hook の guarded auto-refresh は残す。`~/.codex/config.toml` は旧 `codex_hooks = true` に加えて現行 `hooks = true` も有効化する |
| **グローバル E2E 検証** | 2026-04-17 別ディレクトリから `throughline doctor` 全緑を確認 |

### ❌ 未完タスク

| 項目 | 備考 |
|---|---|
| **awesome-claude-code 登録申請** | 初回 public commit から 1 週間経過（2026-04-21 以降）に Web UI 経由で提出 |
| **外部環境での実運用検証** | 別 PC / OS での install、並行 `/clear` 時の merge chain 挙動、1M context 検出のロバストさ、VSCode 系以外のエディタでの token-monitor 挙動、macOS / Linux で OSC 18t がフォールバック経路と実幅取得の両方で正しく動くかの確認 |
| **GitHub Actions 自動 publish** | `release` タグ push をトリガー（Phase 3+、Trusted Publishing 使用） |
| **Claude Code プラグインマーケットプレース登録** | npm 公開の後継ステップ（Phase 3+） |
| **turn-processor.test.mjs の 10 秒タイムアウト解消** | `main()` が stdin を待ち続けるためテストファイルがハングする既存の問題。実装動作は無影響、テスト個別 9/9 は pass |
| **automatic context rollback / inject** | Codex Stop hook auto-refresh は verified usage 75% 以上で guarded rollback + Throughline DB memory inject を試行する。controlled rollback model-visible smoke で復活が未再現となったため、2026-05-06 incident 後の overbroad blocker は解除済み。estimate usage では実行しない |

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
