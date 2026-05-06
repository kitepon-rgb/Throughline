# Throughline: Codex 両対応 + Rollback Trim 実装計画

この文書は TODO を兼ねた実装計画です。

## この文書の位置づけ

この文書は **統合実装計画** です。実装順、TODO、進捗チェックはこの文書を正として扱う。

元文書:

- [THROUGHLINE_CODEX_DUAL_SUPPORT.md](THROUGHLINE_CODEX_DUAL_SUPPORT.md)
- [throughline-rollback-context-trim-insight.md](throughline-rollback-context-trim-insight.md)

関係性:

| 文書 | この計画での扱い |
|---|---|
| [THROUGHLINE_CODEX_DUAL_SUPPORT.md](THROUGHLINE_CODEX_DUAL_SUPPORT.md) | Claude / Codex 両対応の architecture brief。主に Phase 1-5 に対応 |
| [throughline-rollback-context-trim-insight.md](throughline-rollback-context-trim-insight.md) | rollback trim の design insight。主に Phase 6-8 に対応 |

この計画は両者の合流点であり、Claude contract 固定を先行させる。rollback trim は実測 spike を通るまで本線実装にしない。

## 現在の判断

2 つの計画は矛盾しない。ただし、同時に実装へ入ると境界が曖昧になる。

先に固定するべきものは **Claude contract**。Throughline は Claude Code を主軸としてきたプロジェクトであり、Codex 対応や rollback trim は Claude path を置き換えるものではない。

実装順は次を基本線にする。

```text
Claude contract 固定
  -> agent-neutral handoff 境界
  -> Codex sidecar / handoff projection
  -> rollback / inject primitive spike
  -> /tl-trim 系 UX
```

rollback trim は最終的な理想に近いが、host primitive の実測が必要なため、最初の本線実装にしない。

## 絶対に守ること

- Claude hooks、slash command、transcript parsing、handoff baton、SessionStart resume behavior を Codex 用に置き換えない。
- Claude-facing field / command / DB semantics を rename しない。
- Codex 対応は adapter / projection として足す。
- `thread/rollback` / `thread/inject_items` は host primitive として実測済み。Codex は明示 thread identity と rollout/app-server turn count guard がある場合だけ guarded execute を許可する。通常の automatic rollback / inject と Claude `/rewind` 自動化はまだ有効化しない。
- fallback や silent recovery で失敗を隠さない。互換モードは条件と理由を明示する。

## 運用ルール

- この計画書のチェックボックスは、実装 PR / 作業単位ごとに更新する。
- Phase の完了条件は、継続運用ルールではなく、その Phase で閉じられる成果物だけにする。
- README には実装済み behavior だけを載せる。実装前の将来計画をユーザー向け仕様として見せない。

## Phase 0: 計画とドキュメントの整列

目的: 作業者が Claude 正本を見失わない状態にする。

- [x] `AGENTS.md` を追加し、`CLAUDE.md` 正本参照と Claude 主軸を明記する。
- [x] `CLAUDE.md` の必読ドキュメントに、この計画書と元 2 文書を位置付ける。
- [x] README には実装済み behavior だけを載せる方針を運用ルールに明記する。

完了条件:

- [x] Claude / Codex どちらの作業者も、`CLAUDE.md` が正本であることを迷わない。
- [x] 2 つの元計画とこの実装計画の関係が docs 上で追える。

## Phase 1: Claude Contract Audit

目的: Codex 対応の前に、壊してはいけない現行挙動を棚卸しする。

確認対象:

- [x] Claude transcript file shape
- [x] `extractDetailBlocks` の tool input / output / thinking / image / system 分類
- [x] `/tl` による `handoff_batons` 作成
- [x] `save-inflight` による `memo_text` 保存
- [x] `SessionStart` による baton consume と session merge
- [x] `resume-context` の注入順序
- [x] L1 / L2 / L3 保存境界
- [x] `origin_session_id` を維持する merge semantics
- [x] VSCode task provisioning の hook 呼び出し境界
- [x] Stop hook async 登録
- [x] background Claude subagent / external review task の有無。無ければ migration は no-op と記録する

成果物:

- [x] `CLAUDE.md` に現行 contract の索引が不足していれば追記する。
- [x] 既存テストで固定済みの contract と、未固定の contract を一覧化する。
- [x] 未固定のうち Codex 対応で壊れやすいものを Phase 2 の test TODO に送る。

完了条件:

- [x] 「Codex 対応で触ってはいけない Claude 境界」が文書と test TODO の両方で見える。

Audit result (2026-05-06):

| Contract | Current evidence | Status |
|---|---|---|
| Claude transcript block parsing | `src/transcript-reader.test.mjs` covers tool input/output pairing, thinking, image, hook attachments, unknown attachments, ANSI stripping, array content, current-turn slicing | Mostly fixed |
| `/tl` baton table behavior | `src/baton.test.mjs` covers TTL, project scoping, consume deletion, memo read/write, memo preservation | Fixed at baton module level |
| `save-inflight` memo write | `src/baton.test.mjs` covers `updateBatonMemo`; `src/cli/save-inflight.mjs` has CLI behavior but no isolated CLI test | Module fixed, CLI entrypoint not fixed |
| Session merge semantics | `src/session-merger.test.mjs` covers merge target chain, self-handoff refusal, predecessor age guard, already merged guard, row movement, `merged_into` | Fixed at merger module level |
| SessionStart baton consume + resume injection | `src/hook-entrypoints.test.mjs` covers isolated subprocess baton consume, merge, memo injection, and resume context output | Fixed at subprocess fixture level |
| `resume-context` output order | `src/resume-context.test.mjs` covers memo → latest thinking → L1 → L2 → footer, empty context, and current-origin exclusion | Fixed |
| L1/L2 rolling window | `src/turn-processor.test.mjs` covers `L2_WINDOW = 20`, distinct origin×turn counting, oldest unsummarized selection, merge-aware summarization window | Core selection fixed |
| L2/L3 DB persistence from hook | `src/hook-entrypoints.test.mjs` covers `process-turn` subprocess with isolated DB, L2 bodies, L3 thinking/tool input/tool output details | Fixed at subprocess fixture level |
| `origin_session_id` contract | `src/session-merger.test.mjs` and `src/turn-processor.test.mjs` cover origin-aware merge and turn counting | Fixed for core semantics |
| VSCode task provisioning | `src/vscode-task.test.mjs` covers task detection, JSON/JSONC handling, broken task repair, notices, gitignore recommendation; hook entrypoints call it under try/catch | Core fixed |
| Stop hook async registration | `src/cli/install.test.mjs` asserts Stop has `async: true`, SessionStart/UserPromptSubmit stay synchronous | Fixed |
| Background Claude subagent / external review task | The only current subagent-like external model call is L2 → L1 summarization in `src/haiku-summarizer.mjs` via `claude -p`; `/tl` in-flight memo is written by the main Claude agent through `.claude/commands/tl.md` + `save-inflight` | Migrate only L2 → L1 summarization path |

`CLAUDE.md` already contains the relevant source map, hooks contract, schema v7 summary, and test index, so Phase 1 did not require additional `CLAUDE.md` edits.

## Phase 2: Claude Behavior Lock Tests

目的: adapter 分離の前に、現行 Claude path の回帰検出を強くする。

追加または確認するテスト:

- [x] 既存 `transcript-reader.test.mjs` で Claude transcript の L3 抽出がどこまで固定済みか確認する。
- [x] hook entrypoint のテスト方法を決める。`turn-processor.mjs` / `session-start.mjs` / `prompt-submit.mjs` は import-safe な `run()` export にし、CLI / 直接実行時だけ hook body を走らせる。
- [x] CLI subprocess fixture を使う場合は、必ず temp HOME / isolated DB を使う。`src/hook-entrypoints.test.mjs` は `HOME` / `USERPROFILE` を temp dir に差し替えて実ユーザー DB を触らない。
- [x] 不足があれば、turn-processor + DB 保存まで含む integration test で L2 body と L3 details の保存を固定する。
- [x] assistant thinking が `details.kind = 'thinking'` として保存されることを、既存テストまたは integration test で固定する。
- [x] `/tl` 相当の prompt-submit が baton を作る。
- [x] `save-inflight` が同一 project baton に memo を保存する。
- [x] `SessionStart` が TTL 内 baton を consume し、resume context に in-flight memo を含める。
- [x] baton が無い場合は引き継ぎをしない。
- [x] `buildResumeContext` の現行出力順序を fixture で固定する。
- [x] Claude-facing schema / field name の snapshot または focused assertion を置く。

注意:

- 既存テストで十分固定できているものは、新規テストを重複追加しない。
- fixture は Claude transcript の現物仕様を表す。Codex 用 fixture と混ぜない。

Phase 2 implementation result (2026-05-06):

- `turn-processor.mjs` / `session-start.mjs` / `prompt-submit.mjs` は import-safe な `run()` export に変更した。
- `bin/throughline.mjs` は既存 command surface を維持し、各 hook の `run()` を明示実行する。
- `src/hook-entrypoints.test.mjs` は temp HOME / isolated DB で hook subprocess を検証する。
- `src/resume-context.test.mjs` は引き継ぎ注入順序を固定する。
- `src/db-schema.test.mjs` は schema v7 の Claude-facing table / field / index 名を固定する。

完了条件:

- [x] Codex adapter 追加前の Claude path 主要テストが通る。2026-05-06 に `npm test` で 233 tests pass。Codex guarded trim 統合後は nested CLI tests を含めて 324 tests pass。
- [x] Claude transcript / handoff behavior の破壊が test failure になる。

## Phase 3: Agent-neutral Handoff Core

目的: Claude transcript から直接 Codex context block を作るのではなく、安定した中間表現を作る。

設計 TODO:

- [x] 現行 `resume-context` が組み立てている情報を audit する。
- [x] `HandoffRecord` または同等の stable object を、まず DB 永続化しない projection として定義する。
- [x] `HandoffRecord` に含める最小フィールドを決める。
  - session id
  - project path
  - intent（初期値は `continue implementation` などの固定値。DB 由来の推測はしない）
  - constraints（初期値は Claude contract preservation などの固定値。DB 由来の推測はしない）
  - L1 summary
  - recent L2 bodies
  - selected L3 references（初期実装では `throughline detail <時刻>` / `source_id` 参照。file path / line reference は既知の場合だけ付ける）
  - in-flight memo
  - source / origin session references
- [x] Claude resume context は、既存挙動を維持したまま必要なら `HandoffRecord` から生成できるようにする。
- [x] DB schema は Phase 3 では増やさない。永続化が必要になった場合のみ、根拠を添えて別途検討する。

実装 TODO:

- [x] `src/` 内に handoff core module を追加する。
- [x] Claude adapter から handoff core へ依存方向を整理する。
- [x] handoff object の unit test を追加する。
- [x] `src/resume-context.test.mjs` で挙動差分なしを確認する。

Phase 3 implementation result (2026-05-06):

- `src/handoff-record.mjs` を追加した。DB 永続化はせず、schema v7 の `sessions` / `skeletons` / `bodies` / `details` から `handoff_record` v1 を projection する。
- `src/resume-context.mjs` は `HandoffRecord` から Claude-facing Markdown を描画する形に整理した。既存 SessionStart の出力 contract は維持する。
- `HandoffRecord` v1 は `session` / `source` / `intent` / `constraints` / `memory` / `references.l3` / `stats` を持つ。
- `references.l3` は `sourceId` と `throughline detail <HH:MM:SS>` 参照を持つ。file path / line reference は Phase 3 では必須にしない。
- `src/handoff-record.test.mjs` で stable projection、origin 除外、空 projection を固定した。

完了条件:

- [x] Claude path は変わらない。
- [x] Codex adapter が Claude transcript internals を直接読む必要がない。

## Phase 4: Codex Handoff Projection

目的: `throughline_handoff` context block を生成する。

設計 TODO:

- [x] `throughline_handoff` JSON schema を docs に固定する。
- [x] `SidecarContextBlock` に渡す references の最小形式を決める。`codex-sidecar` 実装上 `references[].path` は必須なので、DB / `throughline detail` 参照は `data.detailReferences` に置き、file path / line reference が既知の場合だけ top-level `references` を使う。
- [x] trust / source / kind の値を固定する。
- [x] Codex primary と Claude primary の違いを明文化する。
- [x] Codex-on-Codex recursion policy は、まず明示 config / explicit mode として表現する。自動 host-agent detection は初期実装に入れない。

実装 TODO:

- [x] `HandoffRecord` から `throughline_handoff` block への converter を追加する。
- [x] fixture snapshot を追加する。
- [x] CLI から handoff projection preview を出力できる入口を検討する。

`throughline_handoff` v1 schema:

```json
{
  "kind": "throughline_handoff",
  "source": "throughline",
  "trust": "local",
  "summary": "In-flight handoff: Next: continue",
  "data": {
    "throughlineHandoffSchemaVersion": 1,
    "handoffRecordVersion": 1,
    "sessionId": "session-id",
    "projectPath": "/repo",
    "sourceAgent": "claude",
    "hostMode": "claude-primary",
    "intent": "continue implementation",
    "constraints": ["preserve existing Claude Code hook, slash command, transcript, baton, and resume behavior"],
    "originSessionIds": ["old-session"],
    "stats": {
      "l1Rows": 1,
      "l2Rows": 2,
      "thinkingRows": 1,
      "l3References": 2,
      "preservedContextRows": 3
    },
    "memory": {
      "inflightMemo": "Next: continue",
      "latestThinking": [],
      "l1Summaries": [],
      "recentBodies": []
    },
    "detailReferences": [
      {
        "type": "throughline_detail",
        "label": "tool_input:Bash",
        "command": "throughline detail 12:00:01",
        "sourceId": "toolu_1",
        "detailKind": "tool_input",
        "originSessionId": "old-session",
        "turnNumber": 2
      }
    ]
  }
}
```

Fixed values:

- `kind`: `throughline_handoff`
- `source`: `throughline`
- `trust`: `local`
- `data.throughlineHandoffSchemaVersion`: `1` (`codex-sidecar` の `SidecarContextBlock` は top-level `schemaVersion` を保持しないため)
- `data.sourceAgent`: initially `claude`
- `data.hostMode`: explicit `claude-primary` / `codex-primary` / `unknown`; no automatic host detection in Phase 4

Phase 4 implementation result (2026-05-06):

- `src/codex-handoff.mjs` を追加し、`HandoffRecord` から `throughline_handoff` v1 JSON block を生成する。
- `data.detailReferences` は `throughline detail <HH:MM:SS>` command と `sourceId` を持つ DB reference として固定した。`codex-sidecar` の top-level `references` は file path が既知の場合だけ使う。
- `throughline handoff-preview [--session <id>] [--host-mode <mode>]` を追加し、sidecar 実行なしで JSON projection を確認できる入口を用意した。
- `src/codex-handoff.test.mjs` と `src/handoff-preview.test.mjs` で JSON shape と CLI preview を固定した。

完了条件:

- [x] Codex が読むための context block を、Claude path を変えずに生成できる。
- [x] fixture で JSON shape が固定されている。

## Phase 5: codex-sidecar Read-only Integration

目的: Codex sidecar を review / explore / risk-check 用の独立 second pass として使えるか検証する。

前提:

- `codex-sidecar diagnostics --project <repo> --preset review` が成功する環境だけを configured 以上と扱う。
- `codex` binary の存在だけでは利用可能とみなさない。
- sidecar unavailable / disabled 時に Claude behavior を維持するのは、明示された compatibility mode であり、hidden fallback ではない。
- `codex-sidecar` がこの環境で未導入なら、Phase 5 の外部 smoke は unresolved として記録してよい。ローカルの Claude contract / projection 実装をブロックしない。

TODO:

- [x] diagnostics 実行 wrapper を追加する。
- [x] diagnostics 結果に基づき、Codex unavailable / disabled / configured / operational / work-capable の状態表現を追加する。
- [x] diagnostics failure を明示的な unavailable として扱う。
- [x] L2 → L1 要約で、`codex-sidecar` が configured の場合は `codex-sidecar` を使う。
- [x] `codex-sidecar` が disabled / unavailable の場合は、現行 Claude Haiku 要約を維持する。
- [x] `/tl` in-flight memo は main Claude agent の slash command 手順なので、Codex sidecar へ移さない。
- [x] `codex_explore` read-only smoke を追加する。
- [x] `codex_review` または `codex_risk_check` の sidecar request dry-run を追加する。
- [x] structured result を保存または link する場所を決める。
- [x] Claude primary から Codex sidecar を呼ぶ場合の内部 docs を追加する。README は更新しない。
- [x] Codex primary から Codex sidecar を呼ぶ場合の禁止 / 許可条件を内部 docs に追加する。README は更新しない。

Phase 5 implementation result (2026-05-06):

- `src/codex-sidecar.mjs` を追加し、`diagnoseCodexSidecar()` で `disabled` / `unavailable` / `configured` を返す。
- `THROUGHLINE_CODEX_SIDECAR_DISABLED=1` は明示的な `disabled`。`codex-sidecar` command 不在、spawn failure、diagnostics non-zero は `unavailable`。
- `configured` は `codex-sidecar diagnostics --project <repo> --preset <preset>` が exit 0 の場合だけ。
- `operational` / `work-capable` は status enum として予約したが、read-only / work smoke が未実装なので diagnostics wrapper はまだ返さない。
- `THROUGHLINE_CODEX_SIDECAR_BIN` で明示 command を指定できる。見つからない場合に別 path へ隠れて fallback しない。
- Windows では npm global bin の `.cmd` shim を解決できるよう、`codex-sidecar` subprocess も shell wrap する。これは既存の Claude CLI subprocess と同じ OS 境界対策。
- `throughline codex-sidecar-diagnostics --project <repo> [--preset review]` を追加し、JSON status を出力する。
- `throughline codex-sidecar-dry-run --project <repo> --preset review|risk-check [--context-file <json>] [prompt]` を追加し、sidecar request を Codex App Server へ送らず正規化 JSON として確認できる。
- `codex-sidecar-dry-run --turn-timeout-ms <ms>` は local subprocess timeout だけでなく、sidecar request の `turnTimeoutMs` にも反映する。
- `.codex-sidecar.yml` を追加後、この環境で 2026-05-06 に実行した diagnostics は `configured`。
- sample `throughline_handoff` context を使った read-only `codex-sidecar explore` smoke は 2026-05-06 に成功。`src/handoff-record.mjs` を source of truth、`src/resume-context.mjs` / `src/codex-handoff.mjs` を projection として正しく参照できた。
- sample `throughline_handoff` context を使った `review` / `risk-check` dry-run は 2026-05-06 に成功。`risk-check` は `claude-hooks` / `transcript-parsing` / `sqlite-memory` / `codex-sidecar` / `secrets` focus を保持した。
- structured result の保存 / link 方針: Throughline の L1/L2/L3 memory tables へ sidecar 結果を混ぜない。read-only 実行結果は sidecar の structured JSON stdout を一次成果物とし、実行ログは `rawEventLogRef` を canonical link として扱う。Throughline 側で永続 index が必要になった場合だけ、将来 `sidecar_runs` 相当の別 table / 別 artifact に `workflow` / `preset` / `status` / `rawEventLogRef` / `created_at` を保存する。
- `src/haiku-summarizer.mjs` は L2 → L1 要約時に `codex-sidecar` configured なら `summarize-l1` preset を使い、disabled / unavailable / sidecar run failure の場合は現行 Haiku 経路に戻す。
- `summarize-l1` の sidecar result parser は、旧 fixture の `{status:"ok", summary}` と stable `SidecarResult` の `{summary, confidence, recommendedNextAction}` の両方を受け付ける。
- `/tl` in-flight memo は `.claude/commands/tl.md` が現行メイン Claude に書かせるものであり、subagent / sidecar 置換対象ではない。

完了条件:

- [x] sidecar が無い環境で Claude behavior が維持される。
- [x] sidecar がある環境では read-only second pass が再現可能に動く。無い環境では unavailable / unresolved として記録される。
- [x] hidden fallback なしで状態が説明される。

## Phase 6: Rollback / Inject Spike

目的: rollback trim を本線実装する前に、host primitive の実挙動を測る。

前提:

- Phase 6 は外部 host primitive の試験であり、この環境で Codex app-server または Claude rewind automation が検証できない場合は unresolved として記録してよい。
- unresolved の場合、Phase 8 では自動 rollback 実装に進まず、dry-run / 手動案内までに留める。

Codex spike TODO:

- [x] 小さな test thread を開始する。
- [ ] 複数 turn を作る。単一 turn の full rollback は検証済み。partial rollback は Throughline 統合実装時の harness で追加検証する。
- [x] Codex の host identity model を記録する。`thread_id`、turn index、rollout JSONL、project path の対応を確認する。
- [ ] `thread/rollback` を partial `numTurns` で呼ぶ。複数 turn harness 未作成のため未完了。
- [x] `thread/rollback` を full または near-full `numTurns` で呼ぶ。
- [x] rollback 後の `thread/read includeTurns:true` を確認する。
- [x] rollback 後の rollout JSONL を確認する。
- [x] `thread/inject_items` に最小 memory item を渡す。
- [x] 次 turn で injected memory が model-visible か確認する。
- [ ] `thread/resume` 後も rollback marker と injected memory が効くか確認する。
- [ ] ローカルファイル変更が戻らないことを確認する。schema 上は conversation history only と明記されるが、Throughline 統合 harness で実ファイル変更を含めて確認する。

Claude spike TODO:

- [ ] `/rewind` conversation-only の手動 UX を確認する。
- [ ] 外部ツールから自動化できる surface があるか確認する。
- [ ] 自動化できない場合の `/rewind conversation only` + `/tl restore` 手順を設計する。
- [ ] VSCode extension と CLI で挙動差があるか確認する。

成果物:

- [x] spike 結果を docs に記録する。
- [x] 成功 / 失敗 / unknown を分ける。
- [x] 失敗を隠す代替実装を入れない。

Phase 6 result (2026-05-06):

- `codex-sidecar` read-only `explore` smoke と `review` / `risk-check` dry-run は成功。
- Codex CLI `0.128.0-alpha.1` の app-server schema で `thread/read`、`thread/resume`、`thread/rollback`、`thread/inject_items`、`turn/start` を確認した。
- `stdio://` transport は newline-delimited JSON で実測通過した。`initialize` 後に `thread/read includeTurns:true` が persisted thread を読める。
- `thread/rollback` は persisted thread を直接対象にすると `thread not found` を返す。`thread/resume` で loaded thread にしてから呼ぶ必要がある。
- 検証 thread `019dfaba-f87e-7f41-a144-d5ca7c6dd7f9` で、1 turn を `thread/rollback { numTurns: 1 }` し、`thread/read includeTurns:true` が 0 turns を返すことを確認した。
- `thread/inject_items` に raw Responses API item `{ type: "message", role: "developer", content: [{ type: "input_text", text: "..." }] }` を渡し、次の `turn/start` で injected memory が model-visible になることを確認した。marker `TL_PHASE6_INJECT_OK` を正しく返した。
- Codex host primitive は `verified-host-primitive`。現在は明示 `--codex-thread-id` または env thread identity と rollout/app-server turn count guard がそろった場合だけ、`THROUGHLINE_EXPERIMENTAL_CODEX_TRIM=1` 配下で guarded execute できる。通常の automatic rollback / inject はまだ有効化しない。
- Claude `/rewind conversation only` は手動 UX として扱う。外部ツールからの自動化 surface は未確認。Claude host の automatic rollback / inject は `manual-only`。
- Phase 8 では dry-run / preflight を本線にしつつ、Codex だけ実験フラグ配下の guarded execute を追加した。Claude は manual-only のまま扱う。

完了条件:

- [x] rollback trim を自動実装してよい host と、手動案内に留める host が判断できる。Codex は guarded execute のみ実験フラグ配下で許可し、Claude は manual-only。

## Phase 7: Trim Handoff Model

目的: rollback で削除する前に、Throughline が安全に復元できる memory model を固める。

TODO:

- [x] host identity model を整理する。Claude `session_id`、Codex `thread_id`、`project_path`、origin session / thread references の対応表を作る。Codex は `thread_id` と rollout JSONL を app-server で扱い、明示 identity と turn count guard がある場合だけ guarded execute へ進む。
- [x] current session / thread の captured turn count を記録または導出する方法を決める。
- [x] rollback 可能な最大 turn 数を計算する。
- [x] keep-recent の既定値を決める。
- [x] rollback 後に注入する curated memory の構成を決める。
- [x] L3 detail は inline 注入せず reference 化する方針を確認する。
- [x] trim 実行前の dry-run report を設計する。
- [x] trim audit log を DB に残すか決める。

Phase 7 result (2026-05-06):

- `src/trim-model.mjs` を追加し、schema v7 の `bodies` / `skeletons` から distinct `(origin_session_id, turn_number)` を数えて captured turn count を導出する。
- `keep-recent` 既定値は既存 resume context と同じ `N_RECENT_L2 = 20`。
- rollback candidate は `max(0, capturedTurns - keepRecent)`。`--all` は `keepRecent = 0`。
- curated memory preview は `HandoffRecord` から作る。L1 / recent L2 / latest thinking は preview に含めるが、L3 detail は inline 展開せず `throughline detail <time>` reference として扱う。
- trim audit log は現時点では DB に追加しない。dry-run / preflight / guarded execute の JSON 出力を evidence とする。永続化が必要になったら、memory tables ではなく専用 audit table / artifact に分離する。

完了条件:

- [x] `/tl-trim` が何を削り、何を戻すかを実装前に説明できる。

## Phase 8: `/tl-trim` UX

目的: 同一 session / thread で model-visible context を整理する UX を追加する。

候補コマンド:

```text
/tl-trim
/tl-trim --dry-run
/tl-trim --keep-recent 20
/tl-trim --all
```

TODO:

- [x] Claude 用 slash command と Codex 用 command surface を分ける。
- [x] `/tl-trim --dry-run` を先に実装する。
- [x] host が自動 rollback 非対応の場合、明示的な手動手順を返す。
- [x] 実行前に captured turns / keep turns / injected memory summary を表示する。
- [x] Codex dry-run では `--codex-thread-id` を受け取り、Claude / Throughline の `session_id` と Codex `thread_id` を混同しない形で plan に残す。
- [x] Codex non-dry-run の最初の統合として `--preflight` を追加する。これは app-server の initialize / read / resume だけを実行し、rollback / inject は送らない。
- [x] Codex の guarded execution として `--execute` を追加する。ただし `--host codex`、明示 `--codex-thread-id`、`THROUGHLINE_EXPERIMENTAL_CODEX_TRIM=1` を必須にし、実行後に model turn は開始しない。
- [x] 自動 rollback 対応 host では、実行後に resume / injected memory が有効か検証する。Codex は Phase 6 spike と 2026-05-06 guarded execute smoke で、resume 後 rollback/inject と post-inject visibility を確認した。
- [x] `doctor` に trim 関連診断を追加する。

Phase 8 partial implementation result (2026-05-06):

- `throughline trim --dry-run [--host claude|codex|unknown] [--keep-recent N] [--all] [--session <id>] [--codex-thread-id <id>] [--json]` を追加。
- `throughline trim --dry-run --memo-stdin` を追加。`/tl` が解決した「L1/L2 はあるが今やっている作業として認識されない」問題を `/tl-trim` でも再発させないため、current-work memo を curated memory preview の先頭に入れる。
- non-dry-run `throughline trim` は Claude / unknown host では automatic rollback / inject 未対応として exit 1 で明示拒否する。Codex host では `--execute`、明示または env の thread identity、`THROUGHLINE_EXPERIMENTAL_CODEX_TRIM=1` がそろう場合だけ guarded execute へ進む。
- `src/codex-app-server.mjs` を追加し、newline JSON framing、initialize / read / resume / rollback / inject / turn-start request builder、server line parser をテストで固定した。Codex guarded execute はこの helper を通り、model turn は開始しない。
- `--codex-thread-id` の明示入力を最優先で信頼する。明示入力が無い場合のみ、`THROUGHLINE_CODEX_THREAD_ID` / `CODEX_THREAD_ID` を current-thread identity signal として使う。最新 rollout 推測による automatic trim は行わない。
- `throughline trim --preflight --host codex --codex-thread-id <id> [--json]` を追加した。これは `thread/read` と `thread/resume` が対象 thread に届くことを確認し、`rollbackRequestPreview` を返すが、`thread/rollback` / `thread/inject_items` は送らない。
- `codex-rollout` source の場合、preflight は rollout 側 active turn count と app-server `thread/read` / `thread/resume` の turn count を突き合わせる。不一致または app-server count 不明なら `preflight-refused` として止まり、rollback / inject は送らない。
- 同日、検証 thread `019dfaba-f87e-7f41-a144-d5ca7c6dd7f9` に実 app-server preflight を当て、`readTurns: 1` / `resumedTurns: 1` / `rollbackSent: false` / `injectSent: false` を確認した。
- `throughline trim --execute --host codex --codex-thread-id <id> [--json]` を追加した。これは `THROUGHLINE_EXPERIMENTAL_CODEX_TRIM=1` がある場合だけ、app-server の `thread/read`、`thread/resume`、`thread/rollback`、`thread/inject_items`、確認用 `thread/read` を順に送る。
- 実 app-server smoke では `thread/inject_items` の直後に返る turn 配列が、注入 item の可視化より早い場合があると分かった。そのため `--execute` は rollback 後 turn 数 + 注入 item 数を期待値として、post-inject `thread/read` を短く poll し、`postInjectVisibilityCheck` に `match` / `timeout` / `unchecked` を記録する。
- `codex-rollout` source の guarded execute は rollback 前に同じ turn count check を実行する。不一致または app-server count 不明なら `execute-refused` として止まり、`thread/rollback` / `thread/inject_items` は送らない。
- `--execute` が注入する item は `role: "developer"` の raw Responses message item で、中身は `memoryPreview.text`。`memoryPreview.text` は Reading Contract、Active Work Thread、Continuation Instruction を含むため、L2 を単なる過去ログではなく現在タスクの作業文脈として読む前提を維持する。
- `--execute` は model turn を開始しない。2026-05-06 の実機 smoke では、現在 Codex thread に対して guarded execute が `status: executed` / `rollbackSent: true` / `injectSent: true` で完了し、その後の read-only preflight で rollout/app-server turn count が `21` / `21` の `match` に戻ることを確認した。注入 item の可視化は即時 read では遅れる場合があるため、上記 post-inject poll を入れた。
- fake app-server テストで、env 無しでは app-server を起動せず拒否すること、preflight は rollback / inject を送らないこと、execute は `read -> resume -> rollback -> inject -> read...` の順で curated memory を注入し、post-inject read が遅れて可視化される場合も待つことを固定した。
- `throughline codex-threads [--json] [--all-projects] [--limit N]` を追加した。これは `~/.codex/session_index.jsonl` と `~/.codex/sessions/**/rollout-*.jsonl` を read-only に読み、現在 project の Codex thread id 候補を表示する。候補を出すだけで、自動 trim の対象 thread として採用しない。
- `--host codex --codex-thread-id <id>` の計画作成では、明示 thread id と現在 project に一致する rollout JSONL があれば `codex-rollout` を trim source として使う。これにより Throughline DB の `bodies` が 0 件でも、Codex 側の active turns から rollback candidate と memory preview を作れる。
- `codex-rollout` source は `event_msg:task_started` を turn として扱い、`event_msg:thread_rolled_back` を適用して active turns を再構成する。rollback 済み tail は current memory preview に戻さない。
- Claude slash command [.claude/commands/tl-trim.md](../.claude/commands/tl-trim.md) を追加し、現行 Claude が current-work memo を書いてから `throughline trim --dry-run --host claude --memo-stdin` を呼ぶ dry-run UX にした。
- `throughline install` / `uninstall` は `/tl-trim` も配布 / 削除する。
- `throughline doctor --trim --host claude|codex|unknown` を追加し、default keep-recent、automatic rollback / inject 可否、manual procedure を表示する。Codex host では `THROUGHLINE_CODEX_THREAD_ID` / `CODEX_THREAD_ID` の検出結果も表示する。
- `resume-context` の L2 section を「直近のターン履歴」から「現在進行中の作業履歴 (active work thread)」へ寄せ、読み方の契約を追加した。L2 全体を現在真実とみなすのではなく、古い順の active context として読み、後続行が前の仮説を上書きし得ることを明示する。

Current-work framing research note (2026-05-06):

- 「今取り込み中の内容」をモデルに認識させる専用の汎用フラグは見つからない。Claude / Codex とも、通常は role / instruction authority、現在 turn への近さ、明示的な section boundary、metadata、最新 user request との接続で文脈の読み方が決まる。
- Codex CLI は initial prompt を role 付き item list として組み立て、`system` / `developer` / `user` / `assistant` の authority order を使う。AGENTS 系 project docs は user instruction として集約され、より specific なものが後ろに入る。参考: [OpenAI: Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)。
- Claude Code の `CLAUDE.md` は launch 時に context へ読み込まれる project / user / local instruction であり、永続的な作業状態そのものではない。scope と specificity で効かせる。参考: [Claude Code memory docs](https://code.claude.com/docs/en/memory)。
- Anthropic long-context tips は、長い data は上、query / instructions は後ろに置くと性能が上がる場合があるとし、複数 document は XML / metadata で構造化することを推奨している。参考: [Claude long context prompting tips](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/long-context-tips)。
- OpenAI prompt engineering docs / Cookbook は、Markdown / XML の section boundary、明示 instruction、long context では instruction を冒頭と末尾の両方に置く構成を推奨している。参考: [OpenAI prompt engineering](https://platform.openai.com/docs/guides/prompt-engineering) / [GPT-4.1 Prompting Guide](https://cookbook.openai.com/examples/gpt4-1_prompting_guide)。
- Lost in the Middle は、長文 context 内の関連情報位置で性能が落ち、冒頭または末尾の情報が使われやすいことを示す。参考: [Liu et al., 2023](https://arxiv.org/abs/2307.03172)。
- 結論: in-flight memo は現状の強い補助線として残す。ただし本質は memo そのものではなく、L1/L2 を「現在タスクに使う作業コンテキスト」として role / section / recency / repetition で明示すること。全 L2 を「現在も正しい事実」とラベルするのは危険なので避け、古い順、後続優先、supersession rule、detail-on-demand を冒頭と末尾に置く。
- 実装反映: `resume-context` と `trim` preview は、L2 section を active work thread として構造化し、冒頭の reading contract と末尾の continuation instruction の両方で同じ読み方を繰り返す。

完了条件:

- [x] 対応 host では同一 session / thread の context trim が動く。Codex guarded execute は実機 smoke で現在 thread の rollback / inject を完了し、後続 preflight で rollout/app-server turn count match を確認した。
- [x] Codex では guarded execute path が fake app-server 上で rollback / inject 順序を満たす。
- [x] Codex では明示 thread id の rollout JSONL から active turns / memory preview を作り、DB 未捕捉の Codex 作業でも dry-run / preflight / guarded execute の plan source にできる。
- [x] Codex では `codex-rollout` active turn count と app-server read/resume turn count を突き合わせ、差分がある場合は mutation 前に拒否する。
- [x] 非対応 host では、何が足りないかを明示して止まる。
- [x] Claude の既存 `/tl` baton handoff は残る。

## Phase 9: Release Readiness

目的: 既存ユーザーに誤解なく出せる状態にする。

TODO:

- [x] README に Claude primary / Codex sidecar / rollback trim の関係を書く。
- [x] `CLAUDE.md` の実装済みファイル一覧を更新する。
- [x] `PUBLIC_RELEASE_PLAN.md` に status を反映する。
- [x] CHANGELOG を更新する。
- [x] 推奨 test command を通す。
- [x] Codex sidecar が無い環境の動作確認を行う。
- [x] Claude-only 環境の動作確認を行う。
- [x] npm tarball に README 参照先 docs / slash command / new CLI files が入ることを確認する。

完了条件:

- [x] Claude-only の Throughline として従来通り動く。
- [x] Codex sidecar integration の可用性が明示されている。
- [x] rollback trim の対応 host / 非対応 host が明示されている。

Verification refresh (2026-05-06):

- `node --test src/vscode-task.test.mjs`: 68 tests pass。Claude-facing `<system-reminder>` notice は assertion 対象テスト内で捕捉され、通常の TAP output には漏れない。
- `node --test src/codex-sidecar.test.mjs src/haiku-summarizer.test.mjs src/codex-sidecar-cli.test.mjs`: 16 tests pass。Windows npm bin shim 用 shell wrap と sidecar/Haiku 互換経路を確認。
- `node --test src/codex-app-server.test.mjs src/trim-cli.test.mjs`: 24 tests pass。Codex guarded execute の post-inject visibility polling を含む。
- `codex-sidecar review --project . --preset review ...`: sidecar 側の structured-output validation は failed になったが、raw event log から 3 件の actionable finding を回収し、stable `SidecarResult` parser、`npm test` の nested test coverage、`.codex-sidecar.yml` allowed_paths を修正済み。
- `throughline codex-sidecar-diagnostics --project . --preset review`: `configured`。
- `codex-sidecar explore --project . --preset explore ...`: read-only smoke 成功。`src/token-monitor.mjs` が sidecar から read 可能であることを確認。生成される `.codex-sidecar/logs/` は runtime artifact として `.gitignore` 済み。
- `npm test`: nested `src/cli/*.test.mjs` coverage を含めて 324 tests pass。
- `git diff --check`: pass。
- `npm pack --dry-run`: 73 files。README 参照先 docs / slash command / new CLI files / `.codex-sidecar.yml` を含む。

## Open Questions

- [ ] `HandoffRecord` projection で足りなくなる条件は何か。足りない場合だけ DB 永続化を再検討する。
- [ ] Codex sidecar result は DB に保存するか、artifact path を link するか。
- [ ] Codex primary mode の host-agent detection を、明示 config から自動判定へ拡張する条件は何か。
- [ ] rollback trim の default `keep-recent` は何 turn がよいか。
- [ ] Claude `/rewind` を自動化できない場合、Throughline はどこまで UX を持つべきか。

## 当面の次タスク

- [x] Phase 2 の hook entrypoint test method を決める。
- [x] Phase 2 の不足 integration test を特定する。
- [x] Phase 3 の `HandoffRecord` projection 設計に入る。
- [x] Phase 4 の `throughline_handoff` JSON schema を docs に固定する。
- [x] Phase 5 の `codex-sidecar` diagnostics wrapper に入る。
- [x] Phase 8 の `/tl-trim --dry-run` を実装する。
- [x] Phase 8 の `doctor` trim 診断を追加する。
