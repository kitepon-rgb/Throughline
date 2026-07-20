# Throughline Codex Trim Rollback 修正計画

この文書は、2026-05-06 の Codex trim rollback インシデントを受けた修正 TODO です。

対象インシデント:

- [audit-2026-05/codex-trim-rollback-incident-report.md](audit-2026-05/codex-trim-rollback-incident-report.md)
- Codex thread: `019dfd6f-640e-7dd3-b163-3f9add39fde7`
- 報告元プロジェクト: `/home/kite/projects/Spotter`

## 状態

2026-05-08 update: この計画で一時導入した Codex trim execute / auto-refresh の
過剰 blocker は解除済みです。

現在の証拠では、rollback 対象 user prompt が `compacted.replacement_history` や
quoted/tool-output field に残り得ることは確認済みですが、それが次 turn の
model-visible input に入ることは controlled smoke で再現していません。incident-shaped
run の retained text は risk evidence として残す一方、単独では mutation 前 blocker にしません。
Codex current-thread trim は、明示 `--execute`、Throughline DB injectable memory、
Codex thread identity を条件にした診断用 path として残します。rollout/app-server
turn-count mismatch は診断に残し、app-server `thread/read` / `thread/resume` が同じ
count を返す場合は、その差分で rollback `numTurns` を補正します。
2026-05-10 update: live token_count 実験で、rollback / inject 後に token count が
一時的に下がっても同一 thread で戻る挙動を確認したため、Codex automatic
current-thread refresh は無効化します。`UserPromptSubmit` / `PostToolUse` / `Stop`
hooks は capture / monitor state write のみ行い、`codex_auto_refresh_disabled` で
quiet にします。bare `$throughline` は
`codex-handoff-start --execute --open-host <current-codex-surface>` による
app-server 新スレッド handoff とし、surfaceはCodex UI contextから明示します。

最初のインシデント仮説に対する重要な訂正:

- 対象 rollout には、永続化された `event_msg: thread_rolled_back` marker が
  **存在します**。line `1784`、timestamp `2026-05-06T14:39:44.844Z`、
  `num_turns: 19`。
- したがって主原因は、単純な「rollback marker が書かれなかった」ではありません。
- より強い仮説は、Codex restore が `compacted.replacement_history`、
  あるいは Throughline の現行 guarded execute check が見ていない
  restart / pending input source を使っている、というものです。

## 日本語要約

Throughline は Codex の会話を短くするために、古い会話を rollback して、
必要な記憶だけを developer message として入れ直す。

今回わかった問題は、表の会話履歴には `thread_rolled_back` が残っていても、
その直前の `compacted.replacement_history` に古い user 発言が残っていたこと。
さらに app-server response の一部にも同文が見えたが、後続分類では
`aggregatedOutput` など quoted/tool-output field に限定された。したがって
「新しい user 入力として復活した」とはまだ言い切らず、restore safety risk として扱う。

つまり現状の Throughline は「live app-server では rollback できた」ことを確認しており、
controlled marker では VS Code restart 後の model-visible 復活も再現していない。
一方で `compacted.replacement_history` retention は診断として残す。

## 関係ファイル

関係しそうな実装ファイル:

- `src/cli/trim.mjs`
- `src/codex-app-server.mjs`
- `src/codex-host-primitive-audit.mjs`
- `src/codex-rollout-memory.mjs`
- `src/codex-auto-refresh.mjs`
- `src/trim-model.mjs`
- `src/codex-handoff.mjs`

関係しそうなテスト:

- `src/trim-cli.test.mjs`
- `src/codex-app-server.test.mjs`
- `src/codex-rollout-memory.test.mjs`
- `src/codex-auto-refresh.test.mjs`
- `src/codex-capture.test.mjs`

実装修正後に追従更新が必要な docs:

- `CLAUDE.md`
- `docs/05_codex_first_roadmap.md`
- `docs/07_codex_trim_implementation_plan.md`
- `docs/09_rollback_context_trim_insight.md`
- `docs/04_public_release_plan.md`
- `docs/audit-2026-05/codex-trim-rollback-incident-report.md`

## フェーズ 0: 危険な変更処理を止める

目的: durable restore semantics が未解決の間、古い user prompt が model-visible
input に戻る可能性を安全扱いしない。

2026-05-08 注記: このフェーズは incident 直後の封じ込め履歴です。controlled smoke
で rollback marker の model-visible 復活が未再現だったため、ここで導入した
execute / auto-refresh blocker は後段の製品判断で解除済みです。

TODO:

- [x] bare `$throughline` skill の挙動を変更し、自動では
  `throughline trim --execute --host codex --all` を実行しないようにする。
- [x] `doctor --codex`、`trim --dry-run --host codex --all --json`、
  `trim --preflight --host codex --all --json` は引き続き使えるようにする。
- [x] historical containment: `trim --execute --host codex` は、明示的な experimental / force flag が
  無い限り既定で拒否していた。
- [x] historical containment: 拒否メッセージでは、Codex rollback の VS Code restart / reconnect 越しの
  durability が未解決であることを明示する。
- [x] historical containment: `src/codex-auto-refresh.mjs` の Codex auto-refresh mutation を無効化する。
- [x] Codex thread を mutate しない capture / summarize / resume は維持する。

受け入れ条件:

- [x] historical containment: bare `$throughline` では Codex thread を mutation できない。
- [x] historical containment: Codex Stop hook は rollback / inject による auto-refresh を実行できない状態にしていた。
- [x] 手動 dry-run と preflight は引き続き動く。
- [x] 既存 Claude `/tl` と Claude resume behavior は変わらない。

## フェーズ 1: 注入した記憶の識別を直す

目的: Throughline が自分で注入した記憶を、後から正しく認識できるようにする。

現状のバグ:

- 2026-05-07 修正前、execute は `## Throughline Trim Memory Preview` という見出しの text を注入していた。
- `parseCodexRolloutFile()` は、本文が
  `## Throughline: Active Work Context` で始まる場合だけ、
  Throughline が注入した active-work 記憶と認識する。
- incident rollout では `injectedDeveloperMessages` が `0` だった。

TODO:

- [x] dry-run preview と execute injection の意味を分離する。
  - 実行で注入できるのは Throughline DB 由来の canonical active-work context だけ。
  - Codex rollout 由来の `## Throughline Trim Memory Preview` は plan / dry-run 用で、
    DB memory が無い場合の execute は `injectable_memory_required` で拒否する。
- [x] 実際に注入する developer message では
  `## Throughline: Active Work Context` を使う。
- [x] `## Throughline Trim Memory Preview` は Codex rollout preview 用に限定し、
  execute injection には使わない。
- [x] execute が active-work header を注入することをテストで固定する。
- [x] parser が injected active-work message を数えることをテストで固定する。

受け入れ条件:

- [x] `trim --dry-run` は引き続き preview を表示する。
- [x] `trim --execute` は preview-only rollout text ではなく canonical active-work context を注入する。
- [x] `parseCodexRolloutFile()` が injected Throughline 記憶を正しく報告する。

## フェーズ 2: 圧縮履歴からの復元リスクをモデル化する

目的: rollback 対象の user turn が `compacted.replacement_history` に残っている場合、
Throughline は rollback を安全扱いしてはいけない。

証拠:

- incident line `1775` は `compacted` row。
- その `replacement_history` には、後で risk text match として観測された user
  prompt が含まれている。
- incident line `1784` は `thread_rolled_back { num_turns: 19 }`。
- incident line `1864` / `1865` では、同じ prompt と一致する text が
  restart / reconnect 後の diagnostics に現れている。ただし現時点では、
  これを次 turn の model-visible user message として再投入された証明とは扱わない。

TODO:

- [x] 次を含む fixture data を追加する:
  - 通常の user turns
  - それらの user turns を含む `compacted.replacement_history`
  - `thread_rolled_back`
  - restart simulation 後の duplicate user message
- [x] rollout parsing diagnostics を拡張し、`compacted` rows と
  replacement-history user messages の数を検出する。
- [x] rollback 後も rollback-targeted text が compacted replacement source に
  残っている場合に検出できる diagnostic を追加する。
- [x] この diagnostic を `parseCodexRolloutFile()` に置くか、
  新しい restore-safety module に置くか、trim preflight layer に置くかを決める。
  - 判断: rollout parser に `restoreSafety` diagnostics を置き、trim source /
    dry-run / preflight plan へ伝播する。

受け入れ条件:

- [x] incident-shaped fixture が durable-safety check に失敗する。
- [x] check は plain output と JSON output の両方で risk を説明できる。
- [x] 既存 active-turn reconstruction は引き続き `thread_rolled_back` を正しく適用する。

## フェーズ 3: 事前確認 / 実行の意味を強化する

目的: success status は、実際に証明できたことだけを表すようにする。

現状のバグ:

- 2026-05-07 修正前、durable restart behavior が未検証でも、`trim --execute` は
  `status: executed` / `reason: rollback_and_inject_sent` を返し得る。
- 2026-05-07 修正前、`postInjectVisibilityCheck` が timeout しても、外側の command は executed と
  報告し得る。

TODO:

- [x] `sent` と durable success が混同されないように status を rename / split する。
- [x] たとえば次のような status を追加する:
  - `execute-refused`
  - `execute-sent-live-only`
  - `execute-unverified`
  - `execute-durable-verified`
- [x] post-inject visibility timeout は clean success ではなく unverified と扱う。
- [x] `thread/inject_items` が turn list を返さない developer memory item-level injection は、
  rollback 後 turn count のまま `match` と扱う。injected item を常に turn 増加として
  数える古い前提は捨てる。
- [x] preflight JSON に restore-safety diagnostics を含める。
- [x] historical 2026-05-07: preflight / execute は、既知の `restoreSafety.status: risk` を
  `ready` / success と扱わず、`restore_safety_risk` で拒否していた。
  2026-05-08 unblock 後は diagnostic として表示し、単独では拒否しない。
- [x] preflight / execute は、まだ rollback event が無い rollout でも、
  planned rollback 対象の user text が既存 `compacted.replacement_history` に
  含まれている場合は `planned_restore_safety_risk` を報告する。
  - 2026-05-07 追加修正: incident-shaped live run は実行前
    `restoreSafety.status = ok` だったが、rollback 後に compacted retention が
    risk と判定された。これは実行前にも「rollback 予定 tail user text」と
    compacted replacement history を照合すれば予測可能だったため、
    `inspectCodexPlannedRollbackRestoreSafety()` を追加した。
    2026-05-08 unblock 後は mutation 前 blocker ではなく、dry-run report に
    `Planned rollback restore safety` として表示する。
- [x] execute 後の durable verification は rollout を poll し、遅れて永続化される
  `thread_rolled_back` marker と active-work memory injection を待てるようにする。
- [x] `execute-sent-live-only` は durable success ではないため、CLI exit code は
  失敗扱いにする。
- [x] default execute path では restore-safety diagnostics を表示する。
  - historical 2026-05-07: default execute path 自体を拒否し、明示 local experiment でも
    host primitive audit の same-thread repair contract を要求していた。
  - 2026-05-08 unblock 後: rollout に新しい `thread_rolled_back` marker と
    active-work memory injection が観測される場合だけ
    `execute-durable-verified` / `durableVerification.durableVerified: true` を返す。

受け入れ条件:

- [x] live app-server mutation しか観測していない時、CLI は durable success と言わない。
- [x] live app-server mutation しか観測していない時、CLI は exit 0 で成功扱いしない。
- [x] JSON output 上で live-only と durable-verified を混同できない。
- [x] post-inject timeout と compacted restore risk を別々の test で固定する。
- [x] historical 2026-05-07: 既知の compacted restore risk がある場合、execute は app-server を起動する前に拒否していた。2026-05-08 unblock 後は diagnostic-only。
- [x] historical 2026-05-07: planned rollback が compacted replacement history retained text を対象にする場合、
  preflight / execute は app-server を起動する前に拒否していた。2026-05-08 unblock 後は diagnostic-only。
- [x] durable marker / injected memory row が遅れて rollout に出る場合も、
  poll window 内なら durable verified として確認できる。

## フェーズ 4: 安全な製品仕様を決める

目的: インシデント後のユーザー向け挙動を決める。

製品判断の前提:

- historical 2026-05-07 premise: Codex rollback / inject は、Codex が verified durable restart-safe primitive を
  提供するまで preview-only にする。
- historical 2026-05-07 premise: manual execute は local experiment 用の明示 danger flag だけでは許可しない。
  host primitive audit の same-thread repair contract が
  `candidate-requires-live-validation` を返す場合だけ mutation path へ進める。
- current 2026-05-08 decision: controlled rollback model-visible smoke が app-server
  restart と VS Code reload/reconnect の両方で clean だったため、manual execute と
  automatic mutation は再有効化する。host primitive audit と restore-safety は diagnostic-only。
- 目標は当該 Codex thread の context trim を restart-safe に成立させることであり、
  new-thread handoff は完成形ではない。2026-05-08 unblock 後は current-thread trim
  を本線に戻し、new-thread handoff は明示的に新規 thread で続けたい場合の surface として残す。
- 現行 host では、別 thread の作業継続 surface を new-thread handoff として出す。
  `throughline codex-resume --session codex:<thread-id> --format handoff` で
  新規 Codex thread 用 handoff prompt を描画し、新しい Codex thread へ渡す。
  これは current thread を mutate しない。

TODO:

- [x] Codex app-server が、rollback 済み user text の durable non-resurrection
  primitive を提供しているか調査する。
  - 2026-05-07 調査: `codex app-server --help` と generated schema / TypeScript では
    `thread/rollback`、`thread/inject_items`、`thread/read`、`thread/resume`、
    `thread/compact/start` は確認できたが、rollback 済み user text を deletion /
    isolation / projection で model-visible input から外す documented durable rollback
    primitive は見つからなかった。
  - 2026-05-07 追加実装: `throughline codex-host-primitive-audit` を追加した。
    installed Codex CLI の `codex app-server generate-json-schema --experimental` を
    read-only で実行し、rollback 済み user text を current-thread の model-visible
    input に復活させない deletion / isolation / projection primitive の有無を
    機械判定する。
    実環境の `codex-cli 0.128.0-alpha.1` では method count `89`、
    `thread/rollback` / `thread/inject_items` / `thread/compact/start` /
    `thread/start` / `thread/fork` / `thread/resume` は存在したが、
    current-thread history rewrite / compacted-history clear 系 method は `0`。
    isolation / projection 系 method も `0`。
    `thread/resume(history)` は schema 上存在するが
    `[UNSTABLE] FOR CODEX CLOUD - DO NOT USE` で、さらに `history > path > thread_id`
    の precedence により `thread_id` が無視されるため、Throughline の
    current-thread repair primitive としては採用しない。
    監査結果は `status = host-primitive-audit-blocked` /
    `reason = no_current_thread_restore_non_resurrection_primitive`。
  - 2026-05-08 追加実装: 同 audit に host-agnostic same-thread repair contract を
    追加した。contract は VS Code に依存せず、deletion / isolation / projection の
    いずれかによる rollback non-resurrection guarantee、memory reinjection、
    post-repair host read verification、restart/reconnect non-resurrection smoke を
    要求する。現行 schema では
    `repairContract.status = blocked-missing-current-thread-non-resurrection-guarantee`。
    VS Code restore / log / extension audit はこの contract の evidence collector であり、
    repair primitive そのものではない。
  - historical 2026-05-07: `trim --execute --host codex` は
    `THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE=1` があっても、実行前に
    `codex-host-primitive-audit` 相当の schema audit を走らせ、same-thread
    repair contract が blocked の場合は拒否していた。
  - 2026-05-08 unblock: host primitive audit は diagnostic-only に変更した。
    現行 Codex CLI に same-thread repair primitive が無い事実は表示するが、
    DB memory がある execute を塞がない。rollout/app-server turn-count mismatch は
    診断と app-server count 由来の rollback `numTurns` 補正に使う。
  - `~/.codex/state_5.sqlite` の `threads` table は rollout path / metadata を持つが、
    turn bodies は持たない。turn body の主根拠は rollout JSONL 側である可能性が
    高いが、VS Code extension restore source は別途未確定。
- [x] fresh-thread handoff continuation path を表示する。
  - 2026-05-07 追加: `trim --dry-run --host codex` の plan と
    `doctor --trim --host codex` に fresh-thread handoff path を追加した。
    guided command は `throughline codex-handoff-start --session codex:<thread-id>`。
    smoke command は `throughline codex-handoff-smoke --session codex:<thread-id>`。
    model smoke dry-run は `throughline codex-handoff-model-smoke --session codex:<thread-id> --dry-run --json`。
    memory command は `throughline codex-resume --session codex:<thread-id> --format handoff`。
  - 2026-05-08 unblock 後も、これは current-thread trim の代替ではなく、明示的に
    新規 thread で続けたい場合の選択肢として維持する。
    これは current thread を mutate せず、新しい Codex thread に fresh-thread
    handoff context を渡すための暫定 surface である。完成形はあくまで
    当該 thread の restart-safe trim / repair であり、handoff view は L2 件数 /
    本文長 / detail refs を cap し、full active-work context は通常の
    `codex-resume` text renderer に残す。
  - 2026-05-08 追加: `codex-handoff-smoke` は new-thread handoff prompt の
    fresh-thread header、current-task contract、source session、start instruction、
    mutation boundary、prompt size、detail command dedupe を read-only に検査する。
  - 2026-05-08 追加: `codex-handoff-model-smoke --dry-run` は env なしで
    structural smoke 後の `codex exec --ephemeral --ignore-user-config
    --ignore-rules --sandbox read-only` command boundary と結合 prompt size を
    監査し、Codex CLI / model turn を起動しない。
  - 2026-05-08 追加: `codex-handoff-start` は上記の smoke / model dry-run /
    handoff render / optional live smoke / `--print-prompt` を一つの
    read-only guided start plan として表示する。`--memo-stdin` 時は replay 用の
    個別 command にも `--memo-stdin` を伝播し、same memo を pipe する注意を出す。
  - `thread/fork` / `thread/start` は app-server schema 上存在するが、VS Code の
    current-thread identity switch と compacted-history behavior が未証明なので、
    fresh-thread handoff の内部 primitive には採用しない。
- [x] human-readable dry-run が巨大な memory preview で診断を埋めないようにする。
  - 2026-05-07 追加: text report の `Curated Memory Preview` は
    `previewMaxChars` で truncate する。plan / JSON の `memoryPreview.text` は full のまま。
    Codex では fresh-thread continuation path に新規 thread handoff 用の guided command
    `throughline codex-handoff-start --session codex:<thread-id>` と直接 render command
    `throughline codex-resume --session codex:<thread-id> --format handoff` を表示する。
- [ ] VS Code restore が rollout JSONL、`compacted.replacement_history`、
  別の persisted thread store、pending input queue のどれを使うか調査する。
  - 2026-05-07 partial: `throughline codex-restore-source-audit` を追加した。
    これは Codex rollout、`session_index.jsonl`、`state_*.sqlite`、VS Code
    globalStorage / workspaceStorage 候補、installed OpenAI/Codex VS Code
    extension bundle を read-only で棚卸しする。
  - 実 project thread `019dfddb-8288-7392-a461-bf3ebc5da409` では rollout と
    session index と `state_5.sqlite` の `threads` metadata row が見つかった。
    `agent_job_items` / `stage1_outputs` は content 系 table 候補だが、この
    thread id に紐づく row は 0。VS Code globalStorage / workspaceStorage audit は
    45 files scanned / 0 matches だった。
  - proof scope は `local_restore_source_inventory_only` で、VS Code extension
    restart の実 restore path を直接実行するものではない。そのためこの TODO は
    full VS Code smoke ができるまで未完了のまま残す。
  - 2026-05-07 追加実装: `codex-restore-source-audit` が installed VS Code
    extension bundle の static audit も返すようになった。実環境では
    `openai.chatgpt-26.429.30905-linux-x64` から `thread/read`、`thread/resume`、
    `thread/turns/list`、`thread/compact/start`、`thread/rollback`、
    `markAllConversationsNeedResumeAfterReconnect`、`needs_resume`、
    `codex:persisted-atom:` を検出し、`replacement_history` は未検出。
    conclusion は `vscode_extension_reconnect_appears_to_resume_threads_via_app_server`。
    reconnect 時は in-memory conversation を `needs_resume` に戻し、app-server
    resume/read 系へ寄せる仮説が強い。
  - 2026-05-07 追加実装: `chatgpt.followUpQueueMode`、`send-follow-up-message`、
    `steeringUserMessage` も static signal として
    audit に出すようにした。実環境では follow-up queue signals は yes だが、
    VS Code globalStorage / workspaceStorage は 45 files scanned / 0 matches のまま。
    つまり pending input queue のコード経路はあるが、current thread id または
    retained rollback text を持つ local persisted restore source は未検出。
  - 2026-05-07 追加実装: 同 audit が VS Code `settings.json` と logs も別枠で
    read-only scan するようになった。実環境では VS Code settings は searched だが
    `chatgpt.followUpQueueMode` は not-configured。installed extension package の
    default は `queue`。logs は 1185 files scanned / 1 match で、match は thread id
    のみ。retained rollback text は VS Code logs でも未検出だった。
  - 2026-05-08 追加実装: VS Code logs audit を structured signal に分けた。
    thread id / retained rollback text の raw needle match に加え、
    `Failed to apply patches for conversationId=<thread-id>`、thread stream broadcast、
    `replacement_history` signal を数える。実 current thread の再監査では logs は
    1185 files scanned、raw match files `2`、thread id matches `40`、
    retained rollback text matches `0`、patch apply failures `39`、
    patch failure window `2026-05-07 00:35:35.339 -> 2026-05-07 00:36:29.925`、
    thread stream signals `164`、`replacement_history` signals `0`。
    これは VS Code extension log に thread-specific patch failure が多数ある証拠だが、
    retained rollback text が logs に永続化されている証拠ではない。
  - 同 bundle には webview `localStorage` の `codex:persisted-atom:` prefix も
    見える。これは UI atom persistence であり、rollback 済み user turn の durable
    restore source かは未確定。
- [ ] 当該 thread の restart-safe trim / repair path を実現する。
  - 完成条件は「同じ Codex thread で、rollback 対象 text が model-visible restore
    path から再投入されず、VS Code restart / reconnect 後も復活しない」こと。
  - 実装 contract は host-agnostic に固定する。VS Code は事故境界と実測環境として
    扱い、VS Code 専用 storage / webview patch を product repair primitive として
    直接採用しない。
  - 既存の fresh-thread handoff path はこの TODO の代替完了条件ではない。
  - 候補は、host が current-thread deletion / isolation / projection primitive を
    提供する場合の guarded repair、または host が実際に読む durable source を
    特定した上での current-thread repair である。未特定 source を推測で書き換えない。
  - acceptance は `codex-vscode-rollback-smoke --verify --after-vscode-restart` が
    `restartSafe: true` を返し、`restoreSafety.status = ok`、retained rollback text
    `0`、resurrected user messages `0` になること。
- [ ] live `thread/read` だけに依存しない restart / reconnect smoke を設計する。
  - 2026-05-07 partial: `throughline codex-restore-smoke` を追加した。これは
    fresh Codex app-server process を複数回起動し、`thread/read` / `thread/resume` /
    paginated `thread/turns/list` turn count が rollout active turn count と
    一致し続けるかを read-only で確認する。
  - 2026-05-07 historical count-only 実測: project thread
    `019dfddb-8288-7392-a461-bf3ebc5da409` では 2 cycles とも rollout /
    read / resume turns `14 / 14 / 14` で stable だった。
  - 2026-05-07 追加: smoke の app-server 観測口に `thread/turns/list` を足し、
    `thread/read` / `thread/resume` とは別の paginated turn source も不一致なら
    `app-server-restart-mismatch` にするよう固定した。current incident thread は
    restore-safety risk があるため、この smoke は app-server 起動前に refused する。
    2026-05-08 の risky response inspection では、turn count 安定だけでは成功扱いせず、
    retained rollback text を blocking candidate と quoted/tool-output field に分類する。
  - proof scope は `app_server_process_restart_only` で、VS Code restart /
    reconnect 越しの rollback / inject durability 証明ではない。そのためこの TODO は
    full VS Code smoke ができるまで未完了のまま残す。
  - 2026-05-07 partial: `throughline codex-vscode-restore-smoke` を追加した。
    `--prepare` は hidden active-work marker memory を app-server に注入し、
    VS Code reload / reconnect 後に marker を含まない prompt を送るための
    二段階手順を出す。`--verify` は rollout を読み、prepare 後の assistant
    marker-free smoke prompt、assistant の marker-only answer、user prompt への
    marker leak 不在を検証する。
  - prepare は mutation なので `THROUGHLINE_EXPERIMENTAL_CODEX_VSCODE_RESTORE_SMOKE=1`
    必須。verify は read-only。`restartSafe: true` は `--after-vscode-restart`
    明示と marker proof がそろう場合だけ返す。
  - 2026-05-07 実測: project thread `019dfddb-8288-7392-a461-bf3ebc5da409` で
    `--prepare` が marker `TL_CODEX_VSCODE_RESTORE_46888202` を注入した。
    VS Code reload / reconnect 後に marker-free smoke prompt を送ると、assistant は
    marker-only answer を返した。`--verify --after-vscode-restart` は
    `status = vscode-restart-visible` / `restartSafe = true` を返し、
    `userMarkerMatches = []` だった。
  - 同 run 中に、assistant の通常進捗メッセージに marker が含まれただけで
    false positive になり得る verifier バグも見つけた。修正後は
    marker-free prompt と marker-only answer がそろう場合だけ成功扱いする。
  - これは hidden developer memory の restart / reconnect 後 model visibility 証明であり、
    rollback 済み user turn が復活しないことの証明ではない。そのため、当時は
    automatic trim 再有効化の根拠には使わなかった。
- [x] rollback 非復活 proof を read-only で判定する verifier を追加する。
  - 2026-05-07: `throughline codex-vscode-rollback-smoke --verify` を追加した。
    これは rollout を読み、`thread_rolled_back`、rollback 済み user message、
    rollback 後の user message、`restoreSafety.status = ok` を必須条件にする。
  - `--after-vscode-restart` が無い場合は
    `rollback-nonresurrection-visible-restart-unacknowledged` で止め、
    restart-safe proof とは扱わない。
  - `compacted.replacement_history` に rollback 済み user text が残る場合、
    または rollback 後に同じ user text が再出現する場合は `risk` として拒否する。
  - `parseCodexRolloutFile()` は `userMessagesAfterRollback`、`latestRollbackAt`、
    `restoreSafety.rolledBackTexts` を返すようになった。これで smoke 結果を
    pass/fail だけでなく監査証跡として読める。
- [ ] incident-shaped thread で、rollback 済み user turn が VS Code restart /
  reconnect 後に復活しないことを確認する。
  - 2026-05-07 live run: current VS Code-origin thread
    `019dfddb-8288-7392-a461-bf3ebc5da409` で、ユーザー明示許可後に
    `THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE=1 throughline trim --execute
    --host codex --all --json` を実行した。
  - 実行前 preflight は `preflight-ready`。rollback candidate は 20 turns、
    `restoreSafety.status = ok` だった。
  - historical 2026-05-07 追加修正後、この shape は live mutation 前に
    `planned_restore_safety_risk` として拒否された。これは rollback 後に
    risk になることを、rollback 予定 tail user text と既存
    `compacted.replacement_history` の照合で予測するためだった。
  - historical host primitive audit 必須化後は、同じ command は現行 Codex CLI では
    `codex_execute_blocked_no_current_thread_repair_contract` でも拒否された。
  - execute は live app-server に rollback / inject を送ったが、
    `status = execute-unverified` / `reason =
    post_inject_turn_count_not_visible_after_reads` で成功扱いしなかった。
    2026-05-08 の turn-count expectation 修正後は、developer memory item-level
    injection が即時 `thread/read` の turn count を増やさない場合を正しく扱い、
    同 current thread の追加 live run は `execute-durable-verified` になった。
    rollback / inject の durable evidence は rollout 上の新 rollback event と
    injected active-work memory で判定する。
  - rollout 直読では `thread_rolled_back` が記録され、
    `rollbackEvents = 1`、`rolledBackTurns = 20`、
    `rolledBackUserMessages = 21`、`injectedDeveloperMessages = 2` だった。
  - ただし rollback 対象 user text が `compacted.replacement_history` に残り、
    `restoreSafety.status = risk`、`rollbackTextRetainedInCompacted = 20`。
    2026-05-07 の read-only `codex-vscode-rollback-smoke --verify
    --after-vscode-restart` 再確認では `resurrectedUserMessages = 4` になり、
    `自走して` と `go` が rollback 済み user text と一致した。
    これは incident-shaped thread の restore safety risk であり、non-resurrection
    proof にはならない。ただし、後続の risky restore inspection で app-server
    response 上の retained text は `aggregatedOutput` に限定されたため、
    model-visible user message として再投入された証明とは分けて扱う。
    この count は current thread に同じ user text が追加されると増え得るため、
    固定値ではなく risk の継続指標として扱う。
  - historical 2026-05-07: 実行後 preflight は `restore_safety_risk` で拒否した。
    2026-05-08 unblock 後は、この risky rollout は diagnostic evidence として扱い、
    単独では追加 mutation を止めない。
  - `codex-restore-source-audit` では Codex state DB は metadata only、VS Code
    storage は short needle false positive を除去後 `matches = 0`。VS Code
    extension bundle は reconnect 時に app-server resume/read 系へ寄せる signal を
    持つが、これは static inventory であり restart-safe proof ではない。ただし
    rollout 自体の compacted history に retained rollback text があるため、
    restart-safe とは扱わない。
  - 2026-05-08 read-only 再監査: 同 current thread
    `019dfddb-8288-7392-a461-bf3ebc5da409` は `restoreSafety.status = risk` のまま。
    `capturedTurns = 14`、`compactedReplacementUserMessages = 344`、
    `rollbackTextRetainedInCompacted = 20`、`resurrectedUserMessages = 14`。
    historical `trim --preflight --host codex --all` は
    `restore_safety_risk` で拒否し、`plannedRollbackRestoreSafety` も
    `planned_restore_safety_risk` を報告した。2026-05-08 unblock 後はどちらも
    diagnostic-only。`codex-host-primitive-audit` は
    method count `89` で current-thread rollback non-resurrection primitive なし、
    `codex-restore-source-audit` は state DB を metadata only、VS Code storage
    matches `0`、extension bundle を reconnect -> app-server resume/read 系 signal
    ありと報告した。これは追加の read-only risk evidence であり、
    restart-safe proof でも model-visible reproduction proof でもない。
  - 2026-05-08 追加実装: `codex-restore-source-audit` の VS Code extension
    JSON に bounded `sourceSnippets` と機械判定用 `sourceFacts` を追加した。
    実 bundle では `thread/resume` 近傍に `history:null` と
    `path:c?.rolloutPath??null` があり、reconnect handler 近傍に
    `markAllConversationsNeedResumeAfterReconnect()`、follow-up queue 設定近傍に
    default `queue` が見える。実 audit は
    `sourceFacts.reconnectResumeViaAppServerRolloutPath = true` /
    `hypothesis = reconnect_marks_threads_needing_app_server_resume_from_rollout_path`
    を返す。これで minified bundle の巨大 1 行をそのまま貼らずに、
    restore-path signal の短い監査証跡と機械判定を残せる。ただしこれは static
    source signal であり、rollback 済み user turn の非復活 proof ではない。
  - 2026-05-08 追加実装: VS Code storage audit に SQLite-backed storage
    inventory を追加した。`.vscdb` / `.sqlite` / `.sqlite3` / `.db` 候補を
    read-only で開き、table / searchable column / needle match summary を返す。
    実 current thread の再確認では default VS Code storage roots は 45 files
    scanned、direct matches `0`、SQLite DB candidates `0`、SQLite matches `0`。
    このため current environment では VS Code storage 側に retained rollback
    text を持つ local persisted restore source は見つかっていない。
  - 2026-05-08 追加実装: 同 audit の VS Code logs summary は、thread id matches
    `40`、retained rollback text matches `0`、patch apply failures `39`、
    patch failure window `2026-05-07 00:35:35.339 -> 2026-05-07 00:36:29.925`、
    thread stream signals `164`、`replacement_history` signals `0`。log 上の
    `Failed to apply patches for conversationId=<thread-id>` は VS Code webview 側の
    reconnect / patch apply 問題を示す追加 signal だが、retained rollback text の
    復元 source そのものではない。
  - 2026-05-08 追加実装: installed VS Code extension source audit に
    thread-stream patch path facts を追加した。実 bundle では owner が
    `thread-stream-state-changed` patches を broadcast し、follower が
    `handleThreadStreamStateChanged` 内で patches を conversation state に適用し、
    失敗時に `Failed to apply patches for` を log する経路が見える。実 current
    thread では source fact `threadStreamPatchApplyPathPresent = true` かつ logs の
    patch apply failure `39` により `vscodeThreadStreamPatchFailureSignal = true`。
    これは同一 thread repair の調査対象を VS Code reconnect / follower patch apply
    path に絞る evidence だが、まだ repair primitive そのものではない。
  - 2026-05-08 追加実装: installed VS Code extension source audit に rollback
    non-resurrection projection candidate facts を追加した。削除 primitive だけに
    固定せず、`replacement_history` filter / tombstone、`restoreMessage` suppress /
    exclude / projection、`thread_rolled_back` tombstone のような近傍 signal も
    separate candidate として報告する。実 current thread の再監査では
    reconnect / rollout-path resume / thread-stream patch path は見えるが、
    `VS Code rollback projection candidate: no`。つまり現 bundle では、rollback
    済み source を model-visible input から隔離・投影する明示経路は見つかっていない。
  - 2026-05-08 追加実装: `codex-restore-smoke --inspect-risky-rollout` を追加した。
    historical blocker 期間は `restore_safety_risk` で app-server 起動前に拒否しつつ、
    明示 flag 時だけ read-only に `thread/read` / `thread/resume` /
    `thread/turns/list` response を監査する。実 current thread では
    app-server count は `expectedTurns = 15` / read-resume-list `15 / 15 / 15`
    で安定したが、`restoreTextMatchCheck.status = matches-found` のため
    初期実装では上位 status を `app-server-restore-text-retained` に昇格した。
    `restoreSafetyRiskInspected = true` で CLI exit は失敗扱いのまま。
    retained rollback text 7 件が `thread_read`、`thread_resume`、
    `thread_turns_list` の全 response に出た。これは compacted retained text が
    rollout parser 上だけでなく、fresh app-server の read / resume / list
    response 側にも見えている追加 risk evidence である。
    2026-05-08 の再確認時点では active turn が増えて `expectedTurns = 16` /
    read-resume-list `16 / 16 / 16` だが、retained text 7 件が全 response
    source に残っていた。後続分類では、これらは `aggregatedOutput` に限定され、
    `app-server-restore-text-quoted` / `blocking-candidates=no` へ分離された。
  - 2026-05-08 追加実装: `codex-restore-smoke` の retained text match は JSON path
    と location kind も返すようにした。実 current thread の再確認では
    `expectedTurns = 20` / read-resume-list `20 / 20 / 20` で count は一致するが、
    retained text 7 件は `thread_read` / `thread_resume` /
    `thread_turns_list` の `turns[1].items[*].aggregatedOutput` に出ており、
    location kind は `aggregated_output`。つまり app-server response 上の
    retained text は user message field ではなく、過去 tool/output aggregate に
    引用された text として見えている。このため app-server response retention は
    compacted replacement-history risk と同一視せず、repair source 特定では
    `userMessage.text` / `replacement_history` / `aggregatedOutput` を分けて扱う。
  - 2026-05-08 追加実装: `codex-restore-smoke --inspect-risky-rollout` は
    retained text の location kind から blocking candidate を判定する。direct
    turn text / `replacement_history` は `app-server-restore-text-retained` のまま、
    `aggregatedOutput` だけの場合は `app-server-restore-text-quoted` とし、
    `blocking-candidates=no` を出す。実 current thread の再監査では
    `expectedTurns = 29` / read-resume-list `29 / 29 / 29` で count は一致し、
    retained rollback text 7 件はすべて `aggregated_output` /
    `quoted_or_tool_output_context`、`blocking-candidates=no`。したがって
    app-server response 上の retained text は、現時点では直接の user message
    復活ではなく、過去 tool output aggregate 内の引用として分類される。
- [x] rollback 済み user marker が本当に model-visible かを測る controlled smoke を追加する。
  - 2026-05-08 追加実装: `throughline codex-rollback-model-visible-smoke` を追加した。
    `--prepare` は unique marker を含む user turn を `turn/start` し、完了通知後に
    `thread/rollback numTurns: 1` を送る。これは実 current thread を mutate するため
    `THROUGHLINE_EXPERIMENTAL_CODEX_ROLLBACK_MODEL_VISIBLE_SMOKE=1` 必須。
  - `--verify` は full marker を prompt に含めず、prefix
    `TL_ROLLBACK_MODEL_VISIBLE_` だけを含む model turn を開始する。model が hidden
    full marker を返した場合だけ `status = reproduced`、明示 not-visible token を
    返した場合は `status = not-reproduced`。fake app-server tests では
    `promptIncludesMarker = false` を固定済み。
  - 2026-05-08 追加修正: live run では prepare JSON / assistant 発言 / tool output に
    full marker が出ると同じ thread の後続 model turn がそれを読めるため、汚染になる。
    `--marker-file` を追加し、full marker を local file にだけ保存して CLI output は
    `[redacted]` にする。marker-file prepare では per-trial prefix も生成し、古い
    leaked marker prefix に verify が反応する false positive / inconclusive を避ける。
  - 2026-05-08 実測: current thread
    `019dfddb-8288-7392-a461-bf3ebc5da409` で、汚染除去後の `--marker-file`
    prepare -> immediate fresh app-server verify は `status = not-reproduced` /
    `reason = model_reported_rolled_back_marker_not_visible` /
    `promptIncludesMarker = false` / `observedMarkers = []`。これは VS Code
    reload/reconnect 後 proof ではないが、app-server process restart 境界では
    rollback 済み controlled user marker の model-visible reproduction は未再現。
  - 2026-05-08 追加実測: VS Code reload/reconnect 後 verify 用に
    `.throughline-smoke/rollback-model-visible-after-restart.json` を `0600` で作成し、
    prepare と restart 前 baseline verify を実行済み。baseline は `status =
    not-reproduced` / `promptIncludesMarker = false` / `observedMarkers = []`。
    `.throughline-smoke/` は secret marker を含むため `.gitignore` に追加した。
  - 2026-05-08 追加実測: Windows 側 VS Code window に reload command を送り、
    同じ marker-file run を `--after-vscode-restart` 付きで verify した。結果は
    `status = not-reproduced` /
    `reason = model_reported_rolled_back_marker_not_visible` /
    `promptIncludesMarker = false` / `observedMarkers = []`。controlled user marker の
    rollback 後 model-visible reproduction は、app-server process restart 境界でも
    VS Code reload/reconnect 境界でも未再現。
  - この smoke は「Throughline skill を使った」「VS Code restart した」「以前
    developer memory を注入した」などの混線を避けるため、rollback marker 自体を
    controlled user turn に閉じ込める。今回の clean result は「rollback 済み user
    text が fresh user message / model-visible input として復活した」という仮説を
    弱めるが、`compacted.replacement_history` retention と current-thread repair
    primitive 不在を解消するものではない。
- [x] automatic Codex trim を再有効化するべきか決める。
  - 判断: 再有効化する。controlled rollback model-visible smoke は clean で、
    rollback 済み user marker の VS Code reload/reconnect 後 model-visible reproduction
    は未再現。`compacted.replacement_history` retention は診断として残すが、
    mutation 前 blocker にはしない。
- [x] 明示 `trim --execute --host codex` の製品判断を固定する。
  - 判断: 明示 `--execute` で実行する。env opt-in と host primitive audit gate は外す。
    DB memory が無い場合は mutation 前に拒否する。rollout/app-server turn count がずれる場合は
    refusal ではなく診断に残し、app-server count を正として rollback `numTurns` を補正する。
    実行後は `execute-sent-live-only` /
    `execute-unverified` / `execute-durable-verified` で結果を分ける。

受け入れ条件:

- [x] 決定した behavior が `CLAUDE.md` と roadmap docs に記録されている。
- [x] README には実装済みかつ verified な behavior だけを書く。
- [x] restart-safe evidence がない automatic mutation を安全扱いしている docs が無い。

## フェーズ 5: ドキュメントを訂正する

目的: ドキュメントを訂正済みの証拠と一致させる。

TODO:

- [x] incident report の「durable `thread_rolled_back` event が見つからなかった」
  という記述を訂正する。
- [x] hypothesis を compacted replacement-history restore に言及する形へ更新する。
- [x] Codex Rewind-equivalent trim が complete だという roadmap claim を格下げする。
- [x] Codex auto-refresh は無効化する。明示 `trim --execute --host codex` は
  diagnostic current-thread rollback / inject として残す。
- [x] Codex `UserPromptSubmit` / `PostToolUse` hooks は token-monitor 依存にせず
  rollout capture / monitor state write だけを行う。verified 75% 以上でも current
  session へ `$throughline` workflow 実行指示を注入しない。
- [x] 新セッションが古い「Codex side complete」claim ではなく、この fix plan から
  再開できるように `CLAUDE.md` を更新する。

受け入れ条件:

- [x] 新セッションが `CLAUDE.md` を読んでこの plan に到達できる。
- [x] Codex trim が証明前に restart-safe だと主張している docs が無い。

## 実装順

推奨順:

1. フェーズ 0: 危険な mutation を止める。
2. フェーズ 1: 注入 memory の identity を直す。
3. フェーズ 2: compacted replacement-history regression fixture を追加する。
4. フェーズ 3: status と preflight / execute semantics を直す。
5. フェーズ 4: durable host behavior を調査し、製品仕様を決める。
6. フェーズ 5: 挙動修正後に広範な docs を更新する。

作業量や複雑さを理由に目標を下げない。2026-05-10 時点の製品仕様は、
通常 `$throughline` を新スレッド handoff prompt とし、Codex hooks は automatic
current-thread mutation を行わないこと。明示 `trim --execute --host codex` は診断用
current-thread rollback / inject として残す。restore-safety / host primitive audit /
rollout-app-server turn-count mismatch は diagnostics として残す。
2026-05-09 update: rollout/app-server turn-count mismatch は mutation 前 refusal から外した。
app-server `thread/read` / `thread/resume` が同じ count を返す場合、planned rollback turns に
`readTurns - expectedTurns` を足して `thread/rollback.numTurns` を送る。例:
`expectedTurns = 6` / `readTurns = resumedTurns = 7` / `--all` なら `numTurns = 7`。
