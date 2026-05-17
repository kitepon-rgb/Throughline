# CLAUDE.md

このファイルは Claude Code がこのリポジトリで作業する際のガイダンスです。

## プロジェクト概要

**Throughline** は Claude Code の hooks プラグインで、会話ターンを 3 層 (L1/L2/L3) に分解して SQLite に保存し、`/clear` 後も記憶を復元します。加えてマルチセッション対応のトークンモニター CLI も同梱しています。

**設計の核** (v0.4.0 以降、docs/THROUGHLINE_CLEAR_AUTO_HANDOFF_PLAN.md)

- `/clear` 後も SQLite はそのまま残る。`SessionStart` フックで前任セッションの全レコードを新 session_id に張り替える（記憶張り替え方式）
- **引き継ぎ発火条件は 2 経路 (baton path 優先)**:
  1. **baton path**: 旧セッションで `/tl` または `/clear` を打つと UserPromptSubmit hook が `handoff_batons` テーブルに**そのセッションの** session_id を書き込み、次の新規セッションが TTL 1 時間以内に消費して merge。`source` 値関係なく発火、最も確定的な指名方法。multi-window で「最新更新セッション = clear されたセッション」が成立しないシナリオ (例: ウィンドウ A で `/clear`、ウィンドウ B が直前まで活動中) でも誤った前任を選ばない
  2. **auto path (フォールバック)**: baton が無く、`/clear` 後の SessionStart で `source='clear'` を受け取ったとき、env `THROUGHLINE_DISABLE_AUTO_HANDOFF` が `'1'` でなければ `findLatestClaudePredecessor` heuristic で前任を選び merge + 注入。Claude Code 2.1.128 で `source='clear'` が reliable になったため成立 ([GitHub issue #49937](https://github.com/anthropics/claude-code/issues/49937) は解決済み)。`/clear` が UserPromptSubmit hook に届かない経路 (VSCode 拡張のメニュー由来など) のためのフォールバック
  3. consumeBaton が先発なので両者は構造上同時成立しない
- **注入内容**: L1 (古い turn の要約) + L2 (直近 20 turn の verbatim) + L3 references (`throughline detail <時刻>` の取り出しコマンド一覧)。memo / thinking は注入しない (= L2 全文に最後の assistant turn が含まれるので redundant)
- **thinking の L3 保存**: assistant の extended thinking ブロックは `details` テーブルに `kind='thinking'` で全ターン保存される。`throughline detail <時刻>` で取り出せるが、SessionStart 注入には含めない
- 各レコードは `origin_session_id` を保持するため、複数回の引き継ぎでも記憶がチェーン状に蓄積する（ホップ制限なし）
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` は **使わない**（自動コンパクト依存の設計は放棄済み）
- **フォールバック / 逃げ道のコードを書かない** — [docs/PUBLIC_RELEASE_PLAN.md §0](docs/PUBLIC_RELEASE_PLAN.md) 参照。silent try/catch、`exit(0)` でのエラー隠蔽は禁止

---

## 必読ドキュメント

作業を始める前に以下を読むこと。**憶測で設計を推測しない。ソースと設計書が根拠。**

| ドキュメント | 内容 |
|---|---|
| [docs/L1_L2_L3_REDESIGN.md](docs/L1_L2_L3_REDESIGN.md) | **L1/L2/L3 記憶レイヤーの設計仕様**。ブロック分類ルール、Haiku 呼び出し方針、実装順序、進捗表。schema v4 基盤 + v5 L3 分類拡張まで。以後の v6/v7 追加は本文書とは独立 |
| [docs/INHERITANCE_ON_CLEAR_ONLY.md](docs/INHERITANCE_ON_CLEAR_ONLY.md) | 2026-04 段階のバトン方式採用経緯（履歴扱い）。VSCode `source='clear'` バグの当時の検証記録。現行仕様は [docs/THROUGHLINE_CLEAR_AUTO_HANDOFF_PLAN.md](docs/THROUGHLINE_CLEAR_AUTO_HANDOFF_PLAN.md) を参照 |
| [docs/THROUGHLINE_CLEAR_AUTO_HANDOFF_PLAN.md](docs/THROUGHLINE_CLEAR_AUTO_HANDOFF_PLAN.md) | **v0.4.0 の現行設計仕様** + 実装 TODO。auto path (`source='clear'`) + baton path (`/tl`) の 2 経路、env `THROUGHLINE_DISABLE_AUTO_HANDOFF` |
| [docs/PUBLIC_RELEASE_PLAN.md](docs/PUBLIC_RELEASE_PLAN.md) | 公開配布化プラン（§0 フォールバック禁止ルール、CLI 設計、バージョン別実装ステータス、E2E 検証手順、未完タスク） |
| [docs/THROUGHLINE_CODEX_FIRST_ROADMAP.md](docs/THROUGHLINE_CODEX_FIRST_ROADMAP.md) | **次フェーズの実装順 / TODO**。Codex primary 実用化、Codex Rewind 互換、Claude 側 finalization の順で進める |
| [docs/THROUGHLINE_CODEX_TRIM_ROLLBACK_FIX_PLAN.md](docs/THROUGHLINE_CODEX_TRIM_ROLLBACK_FIX_PLAN.md) | Codex rollback / inject incident の調査・修正履歴。controlled user marker の rollback 後 model-visible reproduction は、fresh app-server verify と VS Code reload/reconnect 後 verify の両方で未再現。ただし live token_count 削減が同一 thread で持続しない実測を受け、Codex hooks からの automatic current-thread refresh は無効化し、`$throughline` は app-server 新スレッド handoff に戻す。明示 `trim --execute --host codex` は診断用 current-thread rollback / inject として残す |
| [docs/THROUGHLINE_CODEX_TRIM_IMPLEMENTATION_PLAN.md](docs/THROUGHLINE_CODEX_TRIM_IMPLEMENTATION_PLAN.md) | Codex 両対応 + rollback trim の旧統合実装計画と実装履歴。完了済み成果と根拠として参照する |
| [docs/THROUGHLINE_CODEX_DUAL_SUPPORT.md](docs/THROUGHLINE_CODEX_DUAL_SUPPORT.md) | Claude / Codex 両対応の architecture brief。Claude path を置き換えず、Codex support を adapter / projection として追加する方針 |
| [docs/throughline-rollback-context-trim-insight.md](docs/throughline-rollback-context-trim-insight.md) | rollback を model-visible context の delete primitive と見る設計メモ。次フェーズでは Codex Rewind 互換の根拠として扱う |
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
| [src/codex-capture.mjs](src/codex-capture.mjs) | Codex rollout JSONL の active turns を Throughline DB の `bodies` に保存する capture adapter。`thread_rolled_back` 適用後の active thread だけを `codex:<thread_id>` session として再構成する |
| [src/codex-rollout-memory.mjs](src/codex-rollout-memory.mjs) | Codex rollout JSONL から active turns / restore-safety diagnostics / trim source を構築する。trim source では現在進行中の in-flight turn と latest rollback 後の未完了 assistant continuation を rollback 候補から除外する。実 rollback 直前に app-server `thread/read` / `thread/resume` が同じ turn count を返し、rollout count と差がある場合は app-server 側の差分で rollback 数を補正する |
| [src/codex-usage.mjs](src/codex-usage.mjs) | Codex rollout の `event_msg` / `token_count` verified shape から monitor 用 usage sample を抽出する。open turn 中は `input_tokens + output_tokens` を live footprint として返し、`task_complete` 後は verified `input_tokens` のみに戻す。`token_count` が無い rollout では active rollout text の `chars / 4` estimate を `estimated: true` として返す |
| [src/codex-auto-refresh.mjs](src/codex-auto-refresh.mjs) | Codex automatic refresh helper。current-thread rollback / inject の判定と backoff ロジックは残すが、helper 自体も default disabled で、現行 Codex hooks はこの helper を呼ばず、常に `codex_auto_refresh_disabled` で quiet にする。明示 `trim --execute --host codex` は診断用 current-thread path として残す |
| [src/codex-handoff.mjs](src/codex-handoff.mjs) | `HandoffRecord` から Codex-facing `throughline_handoff` v1 JSON block と Codex developer-message 用 active-work context を生成。`source='throughline'` / `trust='local'` / `kind='throughline_handoff'` を固定 |
| [src/codex-sidecar.mjs](src/codex-sidecar.mjs) | `codex-sidecar diagnostics` / dry-run wrapper。`disabled` / `unavailable` / `configured` / `operational` / `work-capable` の status enum を持つ。diagnostics wrapper は exit 0 の時だけ `configured` とする |
| [src/token-estimator.mjs](src/token-estimator.mjs) | 補助的なトークン数推定 (length/4) |

### Hook 実装（CLI 経由で呼ばれる）

| ファイル | サブコマンド | Hook event |
|---|---|---|
| [src/session-start.mjs](src/session-start.mjs) | `throughline session-start` | SessionStart |
| [src/turn-processor.mjs](src/turn-processor.mjs) | `throughline process-turn` | Stop |
| [src/prompt-submit.mjs](src/prompt-submit.mjs) | `throughline prompt-submit` | UserPromptSubmit |

上記 hook module は `run()` を export し、直接実行時または [bin/throughline.mjs](bin/throughline.mjs) から呼ばれた時だけ hook body を実行する。import だけでは stdin 待ち、DB 作成、state 書き込みをしない。

### 記憶張り替え・注入共通

| ファイル | 役割 |
|---|---|
| [src/baton.mjs](src/baton.mjs) | `writeBaton` / `consumeBaton`（`/tl` または `/clear` で書き、SessionStart で消費。schema v8 で memo_text 列廃止により `updateBatonMemo` も削除） |
| [src/handoff-record.mjs](src/handoff-record.mjs) | `HandoffRecord` v1 projection。Claude resume context と Codex projection が共有する安定した中間表現。DB 永続化はせず、schema v7 の既存テーブルから組み立てる。`codex:<thread_id>` session は `source.adapter = codex` として扱う |
| [src/session-merger.mjs](src/session-merger.mjs) | `resolveMergeTarget` / `mergeSpecificPredecessor`（BEGIN IMMEDIATE トランザクション） |
| [src/resume-context.mjs](src/resume-context.mjs) | `HandoffRecord` から「中断地点からの再開」注入テキストを描画。**v0.4.12 以降**: ヘッダーは「現在地参照案内」「直前の対話の自然な続きとして応答」「`Bash` ツールで `throughline detail HH:MM:SS` を実行」の 3 行。本文は **現在地アンカー (最新 user + 最新 assistant turn を再掲、各 600 字で truncate)** → L1 → L2 (末尾 anchor) の順。L2 が長くなると末尾 anchor だけでは注意が前半固着し話の流れを取り違える事例があった (`/clear` 直後に L2 先頭の古いターンを「現在の作業」と誤認するケース) ため、最新ターンをヘッダ直下にも再掲して二重に固定する。L3 は独立セクションを持たず、各 L1/L2 行末尾に `(詳細：…)` inline suffix として集約する。L1 行頭は `bodies.created_at` MIN 時刻 (元 body 時刻) で表示し detail 解決可能にする |
| [src/l3-summary.mjs](src/l3-summary.mjs) | resume-context / codex-handoff 共通の L3 inline suffix ヘルパー。`shortenMcpToolName` / `localizeL3Part` / `groupL3ByTurn` / `buildPartsSummary`。MCP ツール名は末尾関数名に短縮、`tool_output` / hook 出力 (`system`) は noise として suffix から除外、`tool_input` 名 (例: Bash) で turn 内 1 件に集約する |
| [src/state-file.mjs](src/state-file.mjs) | セッション単位の状態ファイル (`~/.throughline/state/<session_id>.json`)。`host` 無しは旧 Claude state として normalize し、Codex state は `host: "codex"` / `sessionId: "codex:<thread_id>"` / `rolloutPath` を持つ。ファイル名は URL encode し、Windows でも `codex:` session id を保存できる。`usage` フィールド (tokens/model/contextWindowSize) は Stop 完了時の fallback snapshot。monitor はライブ transcript / rollout を優先し、取れない時だけ snapshot を使う。旧フォーマット (usage 無し) も読める |
| [src/haiku-summarizer.mjs](src/haiku-summarizer.mjs) | L2 → L1 要約。`hostMode: 'claude-primary'` では `codex-sidecar` configured なら `summarize-l1` preset を使い、disabled / unavailable / run failure なら現行 `claude -p --model claude-haiku-4-5-*` 経路を維持する。`hostMode: 'codex-primary'` では Codex CLI backend を使い、失敗時は fallback せず explicit error |
| [src/trim-model.mjs](src/trim-model.mjs) | `throughline trim --dry-run` の plan builder。captured turns / keep-recent / rollback candidate / host boundary / curated memory preview / context reduction estimate を計算する。`--memo-stdin` の current-work memo を先頭に含められる。Codex guarded execute は live app-server guard までの実装であり、restart-safe 成功とは扱わない |
| [src/vscode-task.mjs](src/vscode-task.mjs) | VSCode の `.vscode/tasks.json` を自動プロビジョニング（token-monitor の folderOpen 自動起動）。`ensureMonitorTaskFile` は `throughline install` と **SessionStart / Stop / UserPromptSubmit の 3 hook すべて**から呼ばれる。冪等性ガード付きなので重複呼び出し安全。install または 1 つの hook が発火すれば tasks.json が生える。純 JSON は安全にマージ、JSONC は触らず stderr で手動手順を 1 度だけ案内。**v0.3.23 以降**: `findMonitorTaskIndex` + `isMonitorTaskBroken` で「既存タスクの絶対パスが現環境に存在しない」を検知して `command` / `args` だけを差し替え修復する (`action: 'repaired'`)。クロス環境 (Windows ↔ WSL2 / Linux ↔ macOS) で commit された tasks.json が壊れる問題を解消。`label` / `presentation` 等のユーザーカスタマイズは保持する。**v0.3.24 以降**: `shouldRecommendGitignore` で「git リポジトリ内かつ `.gitignore` に `.vscode/tasks.json` 系エントリが無い」を判定し、created/merged/repaired 時に 1 度だけ stdout に `<system-reminder>` で除外推奨を出す（`.throughline-gitignore-noted` marker で再発抑止）|
| [src/terminal-size.mjs](src/terminal-size.mjs) | OSC 18t (`\x1b[18t`) で端末に実幅を問い合わせるユーティリティ。Windows ConPTY + VSCode task terminal では `process.stdout.columns` が凍結するので、stdin を raw mode で listen して `\x1b[8;rows;cols t` 応答を parse する。Ctrl+C 検知 (0x03) と stop() での raw mode 解除も担当 |

### CLI

| ファイル | サブコマンド |
|---|---|
| [bin/throughline.mjs](bin/throughline.mjs) | ディスパッチャ |
| [src/cli/install.mjs](src/cli/install.mjs) | `install` / `uninstall`（デフォルト global、`--project` で Claude ローカル）。global install は `~/.claude/settings.json` と slash commands に加えて `~/.codex/hooks.json` の UserPromptSubmit / PostToolUse / Stop に絶対 node + `bin/throughline.mjs codex-hook ...` を先頭登録し、`~/.codex/config.toml` の `[features].codex_hooks = true` と `[features].hooks = true` を有効化し、`~/.codex/skills/throughline` に `$throughline` skill を配置する。既存 Caveat / Spotter Codex hooks は保持し、uninstall は Throughline 管理の Codex hook / skill だけ削除する。**v0.3.23 以降**: `resolveThroughlineOnPath` で install 完了時に PATH 上の `throughline` 解決を確認し、見つからなければ stderr に修復手順 (npm prefix → `~/.bashrc` 編集 → `doctor` 確認) を出す。Claude-facing hooks は PATH 解決型のため、`~/.npm-global/bin` を `.profile` だけに書いて bashrc に書き忘れる sudoless prefix 派の silent fail を防ぐ |
| [src/cli/doctor.mjs](src/cli/doctor.mjs) | `doctor` — 環境チェック。`doctor --session <id-prefix>` で特定セッションの state/transcript 整合性を診断。`doctor --trim --host claude|codex|unknown` で trim host boundary を診断し、Codex では host primitive audit status も表示する。`doctor --codex` で Codex primary の thread env / rollout candidates / captured DB sessions / context refresh memory source と `/tl` memory contract、new-thread handoff / safe continuation status、host primitive audit、VSCode monitor task の登録状態 / Reload Window note を診断 |
| [src/cli/status.mjs](src/cli/status.mjs) | `status` — DB 統計表示 |
| [src/cli/handoff-preview.mjs](src/cli/handoff-preview.mjs) | `handoff-preview` — sidecar 実行なしで `throughline_handoff` JSON projection を stdout に出す。`--session <id>` / `--host-mode claude-primary|codex-primary|unknown` |
| [src/cli/codex-capture.mjs](src/cli/codex-capture.mjs) | `codex-capture` — 明示 Codex thread id の rollout active turns を `codex:<thread_id>` session として DB に保存する。thread id が無い場合は自動推測しない |
| [src/cli/codex-summarize.mjs](src/cli/codex-summarize.mjs) | `codex-summarize` — captured `codex:<thread_id>` session の古い L2 を Codex CLI backend で L1 skeleton に要約する。Claude Haiku へ fallback しない |
| [src/cli/codex-resume.mjs](src/cli/codex-resume.mjs) | `codex-resume` — Codex primary 用 active-work context を DB から描画する。`--format handoff` で current thread を mutate しない新規 Codex thread 用 handoff prompt を出す。handoff は L2 件数 / 本文長 / detail refs を cap し、full context は通常 text renderer に残す。`--format item-json` で developer message item JSON を出す。`--memo-stdin` で Codex-primary in-flight memo を先頭に足す |
| [src/cli/codex-handoff-smoke.mjs](src/cli/codex-handoff-smoke.mjs) | `codex-handoff-smoke` — `codex-resume --format handoff` の出力が新規 Codex thread 開始 prompt として貼れるかを read-only 検査する。header / reading contract / source session / start instruction / mutation boundary / prompt size / detail command 重複を確認し、DB / Codex thread は mutate しない |
| [src/cli/codex-handoff-model-smoke.mjs](src/cli/codex-handoff-model-smoke.mjs) | `codex-handoff-model-smoke` — handoff prompt を `codex exec --ephemeral --ignore-user-config --ignore-rules --sandbox read-only` に渡す明示 opt-in model smoke。`--dry-run` は env なしで readiness / command boundary を検査し、`--print-prompt` で結合 prompt を監査用に出せる。`--memo-stdin` で Codex-primary current-work memo を handoff prompt に含める。live smoke は `THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1` 必須。事前に structural handoff smoke が ready でなければ拒否し、current thread は mutate しない |
| [src/cli/codex-handoff-start.mjs](src/cli/codex-handoff-start.mjs) | `codex-handoff-start` — 新規 Codex thread へ移るための guided surface。structural smoke、model smoke dry-run boundary、handoff render command、optional live smoke command、`--print-prompt` の結合済み handoff prompt をまとめて出す。`--execute` では `codex app-server thread/start` + `thread/inject_items` で新 thread に developer memory を注入し、`--open-host auto\|vscode\|cli\|none` で表示を開く。`--memo-stdin` 時は replay 用の個別 command にも `--memo-stdin` を伝播し、same memo を pipe する注意を出す。current thread は mutate しない |
| [src/cli/codex-visibility-smoke.mjs](src/cli/codex-visibility-smoke.mjs) | `codex-visibility-smoke` — Codex active-work memory を app-server に inject し、`turn/start` の marker 応答で model-visible を測る実験 smoke。`--memo-stdin` / `--resume-after-inject` 対応。`THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE=1` 必須。実 Codex host では marker が `item/agentMessage/delta` に出ることを確認済み |
| [src/cli/codex-rollback-model-visible-smoke.mjs](src/cli/codex-rollback-model-visible-smoke.mjs) | `codex-rollback-model-visible-smoke` — controlled two-phase smoke。`--prepare` は unique marker を含む user turn を開始して 1 turn rollback する。`--verify` は full marker ではなく prefix だけを含む prompt で、rollback 済み marker が model-visible かを測る。`THROUGHLINE_EXPERIMENTAL_CODEX_ROLLBACK_MODEL_VISIBLE_SMOKE=1` 必須。`--marker-file` は full marker を同一 thread の chat/tool output に漏らさず、per-trial prefix を使う。`reproduced` は bug reproduction、`not-reproduced` はこの経路では未再現 |
| [src/cli/codex-restore-smoke.mjs](src/cli/codex-restore-smoke.mjs) | `codex-restore-smoke` — Codex thread を新しい app-server process で複数回 `thread/read` / `thread/resume` / `thread/turns/list` し、rollout active turn count と一致するかを測る read-only smoke。`THROUGHLINE_EXPERIMENTAL_CODEX_RESTORE_SMOKE=1` 必須。`--inspect-risky-rollout` は risk rollout を read-only で監査し、retained rollback text が direct turn text / `replacement_history` などの blocking candidate に出た場合は `app-server-restore-text-retained`、`aggregatedOutput` など quoted/tool-output field のみに出た場合は `app-server-restore-text-quoted` とする。proof scope は `app_server_process_restart_only` で、VS Code restart-safe 証明ではない |
| [src/cli/codex-restore-source-audit.mjs](src/cli/codex-restore-source-audit.mjs) | `codex-restore-source-audit` — Codex rollout / `session_index.jsonl` / `state_*.sqlite` / VS Code globalStorage・workspaceStorage 候補 / settings / logs / installed OpenAI-Codex VS Code extension bundle の restore-path signals を read-only で棚卸しする。VS Code storage では `.vscdb` / `.sqlite` / `.sqlite3` / `.db` 候補の table / column / needle match summary も出す。VS Code logs では thread id / retained rollback text / patch apply failure / thread stream broadcast / `replacement_history` signal を分けて報告する。extension bundle では app-server restore / webview persisted atom / follow-up queue / thread-stream patch apply path signals と、`replacement_history` filter / tombstone などの rollback non-resurrection projection candidate を分けて報告する。proof scope は `local_restore_source_inventory_only` で、VS Code restart-safe 証明ではない。VS Code 診断は host-agnostic repair contract の根拠集めであり、repair primitive そのものではない |
| [src/cli/codex-host-primitive-audit.mjs](src/cli/codex-host-primitive-audit.mjs) | `codex-host-primitive-audit` — installed Codex app-server schema を read-only で監査し、same-thread rollback non-resurrection primitive と host-agnostic same-thread repair contract を報告する。contract は deletion / isolation / projection のいずれかによる rollback non-resurrection guarantee、memory reinjection、post-repair read verification、restart/reconnect non-resurrection smoke を要求する。実 `codex-cli 0.128.0-alpha.1` では diagnostic status として `blocked-missing-current-thread-non-resurrection-guarantee` を返すが、Codex trim execute / auto-refresh の blocker にはしない |
| [src/cli/codex-vscode-restore-smoke.mjs](src/cli/codex-vscode-restore-smoke.mjs) | `codex-vscode-restore-smoke` — `--prepare` で hidden active-work marker memory を注入し、VS Code reload / reconnect 後に marker を含まない prompt への応答を `--verify` で rollout 検証する二段階 smoke。prepare は `THROUGHLINE_EXPERIMENTAL_CODEX_VSCODE_RESTORE_SMOKE=1` 必須。実 marker proof は成功済みだが、rollback 非復活証明ではない |
| [src/cli/codex-vscode-rollback-smoke.mjs](src/cli/codex-vscode-rollback-smoke.mjs) | `codex-vscode-rollback-smoke` — rollout を read-only で読み、rollback event、rollback 済み user text、rollback 後 user turn、`restoreSafety.status = ok`、`--after-vscode-restart` がそろう場合だけ rollback 非復活 proof として `restartSafe: true` を返す。incident-shaped live run は `restore_safety_risk` として扱う。text output は retained / resurrected counts と risk type summary を出す |
| [src/cli/codex-sidecar-diagnostics.mjs](src/cli/codex-sidecar-diagnostics.mjs) | `codex-sidecar-diagnostics` — `codex-sidecar diagnostics --project <repo> --preset <preset>` を実行し、JSON status を返す。failure は explicit `unavailable` |
| [src/cli/codex-sidecar-dry-run.mjs](src/cli/codex-sidecar-dry-run.mjs) | `codex-sidecar-dry-run` — `review` / `risk-check` などの sidecar request を Codex App Server へ送らず正規化 JSON として確認する |
| [src/cli/trim.mjs](src/cli/trim.mjs) | `trim --dry-run` / `--preflight` / guarded `--execute`。Codex `--execute` は明示コマンドとして rollback + Throughline DB memory inject を送る。restore-safety diagnostics、host primitive audit、rollout/app-server turn-count mismatch は診断であり、実行前 blocker ではない。結果 status は `execute-sent-live-only` / `execute-unverified` / `execute-durable-verified` に分かれ、durable verified には rollout 上の新 rollback marker と active-work memory injection が必要。developer memory inject は item-level で、`thread/inject_items` が turn list を返さない場合は post-inject turn 増加を期待しない |
| [src/token-monitor.mjs](src/token-monitor.mjs) | `monitor` — マルチセッション対応トークンモニター。Claude transcript / Codex rollout の mtime と live usage を state snapshot より優先するため、Stop hook 完了待ちではなく監視中に更新できる。Codex は `~/.codex/sessions/**/rollout-*.jsonl` も直接 discovery するため、Throughline state 未生成の現在 thread も表示できる。Claude / Codex の host を compact 表示し、Codex usage が estimate の場合は `est` / `win?`、Codex open turn では `input_tokens + output_tokens` を token count に overlay する。Codex 表示 ID は `codex:` prefix を外した raw thread id 先頭 8 桁。`--diag` で TTY/columns/env を出力（描画不具合の切り分け用） |
| [src/sc-detail.mjs](src/sc-detail.mjs) | `/sc-detail <時刻>` スラッシュコマンド（[.claude/commands/sc-detail.md](.claude/commands/sc-detail.md) 経由） |

### スラッシュコマンド

| ファイル | 用途 |
|---|---|
| [.claude/commands/tl.md](.claude/commands/tl.md) | `/tl` — バトン設置 (UserPromptSubmit hook が検出して handoff_batons に書き込む)。v0.4.0 以降は memo 入力を要求しない最小実装 |
| [.claude/commands/sc-detail.md](.claude/commands/sc-detail.md) | `/sc-detail <時刻>` — L2+L3 詳細取得 |

### テスト

| ファイル | 対象 |
|---|---|
| [src/baton.test.mjs](src/baton.test.mjs) | `writeBaton` / `consumeBaton` / TTL 動作 (v8 で memo_text 関連 test 削除) |
| [src/prompt-submit.test.mjs](src/prompt-submit.test.mjs) | `isBatonCommand` / `isClearCommand` の slash command 判定 (`/tl`, `/clear` の単独・引数つき・前後空白・prefix 偽陽性拒否) |
| [src/codex-capture.test.mjs](src/codex-capture.test.mjs) | Codex `codex:<thread_id>` session identity、rollout active turns の L2 capture、`function_call` / `function_call_output` の L3 details capture、rollback tail 再構成、Codex-origin handoff |
| [src/codex-usage.test.mjs](src/codex-usage.test.mjs) | Codex rollout `token_count` usage 抽出、`token_count` 不在時の明示 estimate、空 rollout の null |
| [src/codex-auto-refresh.test.mjs](src/codex-auto-refresh.test.mjs) | Dormant helper の default disabled、75% 閾値、estimate usage の非実行、明示 enabled 時に threshold reached で rollback/inject を呼ぶこと、DB memory が無い場合の skip |
| [src/codex-handoff.test.mjs](src/codex-handoff.test.mjs) | `toThroughlineHandoffBlock` の `throughline_handoff` v1 JSON shape と Codex active-work context renderer |
| [src/codex-summarize.test.mjs](src/codex-summarize.test.mjs) | `throughline codex-summarize` の Codex CLI backend L1 書き込み、L2 window 内 skip |
| [src/codex-visibility-smoke.test.mjs](src/codex-visibility-smoke.test.mjs) | `throughline codex-visibility-smoke` の env guard と fake app-server marker visibility |
| [src/cli/codex-rollback-model-visible-smoke.test.mjs](src/cli/codex-rollback-model-visible-smoke.test.mjs) | `throughline codex-rollback-model-visible-smoke` の env guard、prepare rollback、verify not-reproduced / reproduced 判定、full marker 非漏洩 |
| [src/codex-restore-smoke.test.mjs](src/codex-restore-smoke.test.mjs) | `throughline codex-restore-smoke` の env guard、fresh app-server process 間の stable / mismatch 判定、restore-safety risk の事前拒否、risky read-only inspection 時の `app-server-restore-text-retained` / `app-server-restore-text-quoted` 分類 |
| [src/codex-restore-source-audit.test.mjs](src/codex-restore-source-audit.test.mjs) | `throughline codex-restore-source-audit` の rollout / session index / Codex state DB / VS Code storage / settings / logs / VS Code extension bundle 棚卸しと missing rollout refusal |
| [src/codex-vscode-restore-smoke.test.mjs](src/codex-vscode-restore-smoke.test.mjs) | `throughline codex-vscode-restore-smoke` の prepare env guard、hidden marker prompt、restart acknowledgement、marker leak rejection |
| [src/codex-vscode-rollback-smoke.test.mjs](src/codex-vscode-rollback-smoke.test.mjs) | `throughline codex-vscode-rollback-smoke` の restart acknowledgement 必須化、restore-safety risk refusal、CLI JSON 出力 |
| [src/codex-sidecar.test.mjs](src/codex-sidecar.test.mjs) | `diagnoseCodexSidecar` の disabled / unavailable / configured status と sidecar dry-run request shape |
| [src/codex-sidecar-cli.test.mjs](src/codex-sidecar-cli.test.mjs) | `throughline codex-sidecar-diagnostics` / `throughline codex-sidecar-dry-run` CLI 出力 |
| [src/db-schema.test.mjs](src/db-schema.test.mjs) | schema v7 の Claude-facing table / field / index 名固定 |
| [src/handoff-record.test.mjs](src/handoff-record.test.mjs) | `buildHandoffRecord` の stable projection、origin 除外、空 projection |
| [src/haiku-summarizer.test.mjs](src/haiku-summarizer.test.mjs) | L2 → L1 要約の host mode 分岐、`codex-sidecar` 使用、disabled 時の Haiku 互換経路、Codex CLI backend、Codex CLI failure 非 fallback、再帰ガード |
| [src/handoff-preview.test.mjs](src/handoff-preview.test.mjs) | `throughline handoff-preview` の explicit session / cwd latest session 出力 |
| [src/codex-resume.test.mjs](src/codex-resume.test.mjs) | `throughline codex-resume` の text / developer message item JSON / cwd latest Codex session 出力 |
| [src/hook-entrypoints.test.mjs](src/hook-entrypoints.test.mjs) | import-safe hook module、temp HOME / isolated DB での `prompt-submit` / `session-start` / `process-turn` subprocess 動作。`/tl` baton と `/clear` baton の書き込み、後勝ち上書き、非バトンプロンプトの no-op 確認を含む |
| [src/trim-model.test.mjs](src/trim-model.test.mjs) | `buildTrimPlan` の captured turns / keep-recent / rollback candidate / host boundary / current-work memo preview |
| [src/trim-cli.test.mjs](src/trim-cli.test.mjs) | `throughline trim --dry-run` JSON 出力、`--memo-stdin`、non-dry-run 明示拒否 |
| [src/resume-context.test.mjs](src/resume-context.test.mjs) | `buildResumeContext` の注入順序（in-flight memo → thinking → L1 → L2 → footer）、空 context、current-origin 除外 |
| [src/session-merger.test.mjs](src/session-merger.test.mjs) | `resolveMergeTarget` / `mergeSpecificPredecessor` |
| [src/state-file.test.mjs](src/state-file.test.mjs) | `writeSessionState` / `readAllSessionStates` / `snapshotStateMtimes` / stale 閾値 / `usage` スナップショット / 旧フォーマット互換 / Codex state filename encoding |
| [src/turn-processor.test.mjs](src/turn-processor.test.mjs) | `countDistinctBodyTurns` / `pickOldestUnsummarizedTurn` / 20 ターン境界 |
| [src/token-monitor.test.mjs](src/token-monitor.test.mjs) | CLI 引数、cell 幅、bar/色覚マーカー、`formatTimeAgo`、`shouldForceFullRedraw`、`formatLine` の ago 配置 / Codex estimated marker |
| [src/transcript-reader.test.mjs](src/transcript-reader.test.mjs) | transcript JSONL パーサー、`extractDetailBlocks` の全 kind 分類 |
| [src/transcript-usage.test.mjs](src/transcript-usage.test.mjs) | `readLatestUsage` / `inferContextWindowSize` / 1M sticky / size+mtime キャッシュ |
| [src/vscode-task.test.mjs](src/vscode-task.test.mjs) | `ensureMonitorTaskFile` の全分岐 (created / merged / repaired / already_present / skipped×複数 reason)、JSONC 検出、インデント保持、冪等性、`buildSetupNotice` と created/merged/repaired 時の stdout 通知。`findMonitorTaskIndex` / `isMonitorTaskBroken` の単体テスト (v0.3.23+)。`shouldRecommendGitignore` と gitignore 推奨 1 度だけ通知 (v0.3.24+) |
| [src/terminal-size.test.mjs](src/terminal-size.test.mjs) | `parseSizeResponse` / `startSizeQuery` — OSC 18t 応答パース、raw mode 遷移、分割到着、Ctrl+C 捕捉、stop() 冪等性 |
| [src/cli/doctor.test.mjs](src/cli/doctor.test.mjs) | `doctor --session` / `doctor --trim` / `doctor --codex` 用の `parseArgs` / diagnostics helpers |
| [src/cli/install.test.mjs](src/cli/install.test.mjs) | `run` (install / uninstall) の冪等性、`--project` スコープ、Claude Stop `async: true` / Codex Stop `async: false` 登録、既存 Codex hook shape 更新、slash command 配置、`resolveThroughlineOnPath` の PATH 解決テスト (v0.3.23+) |

```bash
# 全テスト
npm test
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
    "Stop":             [{ "hooks": [{ "command": "throughline process-turn", "async": true } ] }],
    "UserPromptSubmit": [{ "hooks": [{ "command": "throughline prompt-submit" }] }]
  }
}
```

global install 時は Codex 側も [src/cli/install.mjs](src/cli/install.mjs) の `CODEX_HOOKS` が正。

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "command": "/abs/node /abs/throughline/bin/throughline.mjs codex-hook user-prompt-submit", "async": false, "timeoutSec": 30 }] }],
    "PostToolUse": [{ "hooks": [{ "command": "/abs/node /abs/throughline/bin/throughline.mjs codex-hook post-tool-use", "async": false, "timeoutSec": 30 }] }],
    "Stop": [{ "hooks": [{ "command": "/abs/node /abs/throughline/bin/throughline.mjs codex-hook stop", "async": false, "timeoutSec": 300 }] }]
  }
}
```

あわせて `~/.codex/config.toml` の `[features].codex_hooks = true` と `[features].hooks = true` を有効化し、`~/.codex/skills/throughline` に `$throughline` skill を配置する。`throughline uninstall` は Throughline 管理の Codex UserPromptSubmit / PostToolUse / Stop hook と skill だけを削除し、Caveat / Spotter など既存の非 Throughline hook / skill は保持する。

- **Claude Stop は `async: true`、Codex hooks は `async: false` で登録する。** Claude 側の `throughline process-turn` は内部で `claude -p --model haiku` subprocess を起動するため、同期実行だとターン完了 → ユーザー表示を数秒〜数十秒ブロックしていた。Claude L1 要約は**次** SessionStart 注入用なので今ターンをブロックする必要がない → async 化。Codex 側は Caveat の実測済み Codex hook と同じく同期登録にする。Codex `async: true` では Throughline DB capture / monitor state write が自然に進んだか確認しづらく、既存登録済み hook も `throughline install` で `async: false` に更新する。
- Codex hooks は bare `throughline codex-hook ...` ではなく、絶対 node path + installed `bin/throughline.mjs` で登録する。Codex App Server / VSCode host の PATH は対話 shell と一致しないことがあり、Caveat の動作実績もこの絶対パス型だった。既存の bare Throughline Codex hook は次回 `throughline install` で絶対パス型へ置換する。
- hook shape 変更前から開いている Codex VSCode session は、変更後の自然 Stop smoke として扱わない。Codex host が session 開始時に hook config を読んでいる可能性を排除できないため、VSCode-origin を実測する場合は変更後に新しい Codex session を開始して `doctor --codex` で latest DB session を確認する。
- `doctor --codex` は `~/.codex/hooks.json` の登録有無だけでなく、Codex の新 hook trust gate (`~/.codex/config.toml` の `[hooks.state."<hooks.json>:event:i:j"].trusted_hash`) も表示する。`registered` でも `trusted: no` の hook は Codex の hook 受け入れメニューで承認されるまで実行されない可能性がある。
- 2026-05-06 の最終実測では、hook shape 変更後に新しく開始した VSCode-origin Codex thread `019dfd62-9a9d-7211-bf91-89d8e3fc908e` で自然 Stop hook が発火し、`doctor --codex` の `current Codex thread` と `latest DB session: codex:019dfd62-9a9d-7211-bf91-89d8e3fc908e` が一致した。これにより VSCode-origin の自然 DB capture も確認済み。
- Codex の bare `$throughline` は、Claude の `/clear` 後継続に近い新スレッド handoff surface とする。通常 path は `throughline codex-handoff-start --execute` で、current thread を rollback / inject しない。`doctor --codex` / `trim --dry-run --all` / `trim --preflight --all` / 明示 `trim --execute --host codex --all` は診断・手動 current-thread 実験用に残すが、通常 `$throughline` の前段にはしない。
- Codex UserPromptSubmit / PostToolUse hooks は token-monitor に依存せず rollout capture と monitor state write だけを行う。verified 75% 以上でも `$throughline` workflow 実行指示を `additionalContext` で注入しない。戻り値は `codex_auto_refresh_disabled` で quiet にし、同じ thread / 同じ状態で自動発火し続けない。
- Codex Stop hook は DB capture / L1 summarize に加え、monitor 用 state も書く。`transcriptPath` は Claude transcript 用に残し、Codex rollout path は `rolloutPath` に保存する。monitor は state の `rolloutPath` と、state 未生成でも `~/.codex/sessions/**/rollout-*.jsonl` から直接 discovery した Codex rollout をライブに読み、`token_count` event がある場合は実測 usage として出し、無い場合だけ `estimated: true` の明示 estimate を出す。
- Codex Stop hook は automatic refresh mutation を実行しない。verified usage が `75%` 以上でも rollback / inject を送らず、capture / L1 summarize / monitor state write のあと `codex_auto_refresh_disabled` を返す。current-thread rollback / inject は明示 `trim --execute --host codex` の診断用 path に限定する。
- Codex guarded trim の rollback source は rollout を使って計画するが、実 rollback 直前に app-server `thread/read` / `thread/resume` が同じ turn count を返し、rollout count と差がある場合は app-server 側の差分で `numTurns` を補正する。turn-count mismatch は診断であり mutation 前 blocker ではない。注入 memory は Throughline DB の `/tl` contract を正とする。`--session` 未指定時の Codex memory source は現在の `CODEX_THREAD_ID` / `THROUGHLINE_CODEX_THREAD_ID` に対応する `codex:<thread_id>` であり、同じ project の latest session へ fallback しない。古い turn は L1 summaries、直近 20 turn は L2 full bodies、L3 は reference only で、L3 bodies / tool payloads は注入しない。rollout preview を DB memory の代わりとして注入せず、DB memory が無い execute は mutation 前に拒否する。`codex-host-primitive-audit` と restore-safety diagnostics は表示するが、mutation 前 blocker にはしない。`doctor --codex` と `doctor --trim --host codex` はこの inject memory source / contract / L1-L2-L3 counts を表示する。
- Codex trim の削減量は host tokenizer の厳密実測ではなく、現時点では rollout text の `chars / 4` heuristic estimate として dry-run に表示する。rollback candidate turns が 0 の場合は、削減量も 0 と明示する。
- L2 → L1 要約は現行実装で唯一の subagent 的 external model call。`codex-sidecar` が configured の環境では `summarize-l1` preset を使い、使えない場合は従来通り Claude Haiku 経路を使う。`/tl` の in-flight memo はメイン Claude が slash command 手順で書くため sidecar 移行対象ではない
- Claude CLI を実際に呼ぶテスト / smoke は、明示的に必要な場合だけ実行し、モデルは Haiku を使う。他モデルを使う必要がある場合は根拠を残してから実行する
- 現行 install は Throughline 管理 Codex hook の shape を更新する。同じ `throughline codex-hook stop` command が既にあっても、絶対パス型 command / `timeoutSec` / `async` などを [src/cli/install.mjs](src/cli/install.mjs) の生成値に合わせる。
- **UserPromptSubmit** は `/tl` または `/clear` バトン書き込み + VSCode tasks.json 自動プロビジョニングの 2 役 (v0.3.18+, /clear バトンは v0.4.x+)。Claude への注入は一切しない（SessionStart 側との重複注入回避のため）。tasks.json 作成は SessionStart / Stop にも同じ呼び出しがあり、どれか 1 つでも発火すれば生成される（冪等）
- **Claude PostToolUse** は登録しない（schema v4 で廃止）。Codex PostToolUse は別用途で、tool loop 中の rollout capture / monitor state write hook として登録する。current-session refresh instruction は注入しない。
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
- `handoff_batons` (v8) — `project_path (PK)`, `session_id`, `created_at` — `/tl` で書き込み、SessionStart が TTL 1h 以内なら消費して merge。memo_text 列は v8 で drop (memo 廃止)
- `injection_log` — 監査用（未活用）

`judgments` テーブルは v4 で DROP 済み。`classifier.mjs` による抽出は精度が低く廃止。

---

## 開発コマンド

```bash
# hooks セットアップ（このリポジトリだけに限定）
node bin/throughline.mjs install --project

# hooks 削除
node bin/throughline.mjs uninstall --project

# テスト
npm test

# モニター（別ターミナルで常駐、VSCode タスクが自動起動するので通常は手動不要）
node src/token-monitor.mjs

# 特定セッションの診断（モニターが止まって見える時の切り分け）
node bin/throughline.mjs doctor --session <id-prefix>

# DB 統計
node bin/throughline.mjs status

# Codex-facing handoff JSON preview
node bin/throughline.mjs handoff-preview --session <id>

# Codex primary active-work context
node bin/throughline.mjs codex-summarize --session codex:<thread-id> --json
node bin/throughline.mjs codex-resume --session codex:<thread-id>
node bin/throughline.mjs codex-resume --session codex:<thread-id> --format handoff
node bin/throughline.mjs codex-handoff-start --session codex:<thread-id>
node bin/throughline.mjs codex-handoff-smoke --session codex:<thread-id> --json
node bin/throughline.mjs codex-handoff-model-smoke --session codex:<thread-id> --dry-run --json
THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1 \
  node bin/throughline.mjs codex-handoff-model-smoke --session codex:<thread-id> --json
node bin/throughline.mjs codex-resume --session codex:<thread-id> --format item-json
printf '**Next move**: continue the Codex implementation\n' \
  | node bin/throughline.mjs codex-resume --session codex:<thread-id> --memo-stdin

# Experimental Codex model-visible smoke (starts a model turn)
printf '**Next move**: continue the Codex implementation\n' \
  | THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE=1 \
      node bin/throughline.mjs codex-visibility-smoke --session codex:<thread-id> --memo-stdin \
        --request-timeout-ms 150000 --timeout-ms 180000 --json

# Codex sidecar diagnostics (configured 以外は exit 1)
node bin/throughline.mjs codex-sidecar-diagnostics --project .

# Codex sidecar dry-run (review / risk-check request shape)
node bin/throughline.mjs codex-sidecar-dry-run --project . --preset risk-check --context-file docs/throughline-handoff-context.example.json

# Trim dry-run / guarded Codex execute surface
printf '**次の一手**: ...\n' | node bin/throughline.mjs trim --dry-run --host claude --memo-stdin --json

# Trim host boundary diagnosis
node bin/throughline.mjs doctor --trim --host claude

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
- **進捗を docs に残す**。計画書のチェックボックスと CLAUDE.md のステータス行を同時に更新する。README には実装済み behavior だけを載せる
- **新しい .md ファイルを作る前に、既存ファイルに追記できないか考える**。docs フォルダが肥大化する原因はほぼこれ
- **破棄された設計は `docs/archive/` に移動**。現行 docs と歴史記述を同じ階層に混在させない
