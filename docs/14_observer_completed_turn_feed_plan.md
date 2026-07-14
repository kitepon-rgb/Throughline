# Observer向けClaude／Codex completed-turn feed実装計画

**Status:** Active

**作成日:** 2026-07-14

**依頼元:** Observer v1

この文書は、指定projectで最後に完了したClaude／Codex親threadとhostを解決し、完了turnの差分readと最大一時間のwaitをJSON-only CLIとして提供するThroughline側の正本計画/TODOである。

## 目的

Observerはproject絶対pathだけを指定し、親threadの作り直しとClaude／Codex間のhost切替へ追従する。Throughlineはhostごとに実証された完了証拠を使い、進行中turnを除外したhost-bound opaque cursor、read、waitを所有する。Codexはrolloutの`task_complete`を使い、ClaudeはObserver側Phase 0と共同で実hostから確定した証拠だけを採用する。

```text
Observer MCP adapter
  └─ Throughline JSON CLIへwaitを要求
       └─ host固有の完了証拠で閉じたcursorだけを監視
            ├─ changed / timeout / resync_required
            └─ readでsnapshot / delta / thread_switchedを取得
```

MCP serverはObserverが所有する。Throughlineは既存の外部依存ゼロ構成を維持し、library + CLI契約だけを追加する。

## 非目標

- Throughline DB / hook / schemaの意味変更
- Observer state、Mailbox、dedupeの保存
- AI監査、助言生成、親への配送
- Throughline本体へのMCP SDKまたはMCP server追加
- DB / WAL / file mtimeを完了通知の正本にすること
- 同一projectで複数親が同時活動する場合の競合解決
- 既存Claude-facing hook、handoff、monitor挙動の互換破壊
- Codexの`task_complete`をClaudeへ推測適用すること

## 現行根拠

- `src/codex-rollout-memory.mjs`は`task_complete`を解釈し、`includeInFlightTurn:false`で進行中turnを除外できる。
- `src/codex-thread-index.mjs`はproject配下のrollout候補を解決できるが、現在の並び順はmtimeであり、feedの親選択には使わない。
- `src/auditor-context.mjs`はread-only DB、schema v8、project、origin session、user / assistant hashによるfreshness照合を持つ。
- Claude transcript／sessionと既存Stop hookはfirst-classのまま維持し、Observer用の「完了turn」境界は[ADR 0002](adr/0002-observer-claude-completion-receipt.md)のThroughline所有Stop receiptへ固定した。
- 現行DB projectionは進行中turnを含みうるため、`sessions.updated_at`、body ID、body件数をcursorにできない。

## 公開CLI

```bash
throughline observer-read \
  --project /absolute/project \
  [--after-cursor <opaque>] \
  [--through-cursor <opaque>] \
  [--page-token <opaque>] \
  [--limit 10] \
  --json

throughline observer-wait \
  --project /absolute/project \
  --after-cursor <opaque> \
  [--timeout-seconds 3600] \
  --json
```

- stdoutは成功・既知状態とも単一JSONだけを返す。
- diagnosticsはstderrへ出す。
- 引数、permission、schema、I/Oのhard failureは固定code付きerror JSONとnon-zero exitにする。
- projectは既存directoryの絶対pathだけを受理し、realpathでcanonicalizeする。
- ObserverはCLIを子processとして呼び、DBやrolloutを直接読まない。

## Cursor契約

- schemaは`throughline.observer_cursor.v1`。
- tokenはopaqueかつboundedで、本文、path、secretを含めない。
- project identity、host identity、選択thread、host固有の完了pair prefixをThroughlineだけが検証できる情報を持つ。
- DB row ID、turn ordinal、mtime、`sessions.updated_at`を安定identityとして使わない。
- Observerは保存、比較、返送だけを行い、decode、採番、改変しない。
- project不一致、version不一致、同一threadのprefix不一致、rollbackは`resync_required`とする。
- 完了turnがまだ無いprojectにもempty baseline cursorを返し、最初の`task_complete`を待てるようにする。

## 最新親host／threadの解決

1. projectと同じ、または配下cwdを持つClaude sessionとCodex rollout候補を列挙する。
2. 各候補をhost固有のcompleted-only parserで解析する。
3. Codexは`task_complete`、ClaudeはPhase 0で実証した完了証拠で閉じたuser / assistant pairだけを候補にする。
4. 最後の完了時刻が最新のhost／threadを現在親として選ぶ。
5. 同一host内の同時刻はthread ID、source pathの順で決定的に解決する。異なるhostが一意に解決できない場合は`ambiguous_parent`としてfail closedにする。

rollout mtime、session index更新時刻、DB更新時刻だけで親を選ばない。v1は同一projectの活動親が一つという前提を明示する。

## Wait wire

```json
{
  "schema": "throughline.observer_wait.v1",
  "status": "changed",
  "afterCursor": "tlc1:...",
  "throughCursor": "tlc1:..."
}
```

`status`:

- `changed`: 呼出時点または待機中にcompleted cursorが変化した。
- `timeout`: deadlineまで変化なし。返すcursorは入力と同値。
- `resync_required`: cursorがproject、version、rollback、prefix検証に失敗した。
- `ambiguous_parent`: Claude／Codexの現在親を一意に解決できない。推測でcursorを進めない。

実装は呼出直後に再計算し、以後は短いintervalで再確認する。DB transactionを待機中に保持しない。timeout境界で最後に一度再確認し、missed wakeupを防ぐ。AbortSignal / SIGINT / SIGTERMではtimerとfile handleを閉じ、成功JSONを偽装しない。

## Read wire

```json
{
  "schema": "throughline.observer_read.v1",
  "status": "delta",
  "host": "codex",
  "thread_sha256": "5a8f...",
  "afterCursor": "tlc1:...",
  "throughCursor": "tlc1:...",
  "turns": [],
  "page": {
    "complete": true,
    "nextToken": null
  }
}
```

`status`:

- `snapshot`: 初回orientation。最新のbounded履歴を返し、過去の省略は`historyTruncated`で明示する。
- `delta`: 同一threadの未読完了turn。
- `thread_switched`: 最新親が別threadへ移った。新threadの完了turnを先頭からpage化する。
- `host_switched`: 最新親がClaude／Codex間で切り替わった。新host／threadの完了turnを先頭からpage化する。
- `resync_required`: cursor / prefixを信頼できない。本文を通常deltaとして返さない。
- `projection_pending`: rolloutは完了済みだがDB freshness照合が未成立。Observerはcursorを進めず再試行する。

`throughCursor`は一回のread seriesの上限を固定する。途中で新turnが完了しても現在pageへ混ぜず、次のwaitで回収する。`page.nextToken`はafter / through / projectへ束縛したopaque tokenとする。snapshot以外の上限超過はpaginationし、黙ってdropまたは成功truncateしない。

turn本文は既存auditor projectionと同様に件数、各body、総文字数をboundedにし、各turnへcontent digestと`truncated`を付ける。truncationがある時、Observerは証拠不足の断定をしてはならない。

## Freshnessと競合

- host固有のcompleted-only pair chainをcursor正本にする。
- DB本文は`auditor-context`相当のproject / session / user hash / assistant hash照合を通す。
- Stop hook同士は並行しうるため、DBに本文があってもhost固有の最終完了証拠まではchangedにしない。
- waitがchangedを返した直後にDBがfreshでなければ、readは`projection_pending`を返す。
- Observerは全pageのreadと監査が成功した後だけ保存cursorを進める。
- crash、cancel、read失敗では旧cursorを維持する。

## 実装TODO

### Phase 0: Characterization

- [ ] 進行中turnを含むDBとcompleted-only rolloutの差をfixture testで固定する。
- [ ] Stop continuation後、最終`task_complete`までcursorが進まないtestを置く。
- [x] rollbackでordinalが変わってもpair hash prefixで検出できるtestを置く。
- [x] project配下cwdと別projectの候補分離を固定する。
- [x] Claude transcript、Throughline DB projection、Stop hookの順序を実hostで観測し、完了turnを進行中turnから分ける正式証拠を裁定する。
  - Claude Code 2.1.207／Haiku 4.5／plan権限で、final assistant後にStop hooksが走ることを実hostで確認した。final assistant、process exit、mtimeを証拠にせず、Throughline Stop hookがpair capture成功後に書く製品所有receiptを採用する。正本は[ADR 0002](adr/0002-observer-claude-completion-receipt.md)。
- [x] Claudeのthread identity、project解決、continuation後の完了境界、再起動／resumeをfixtureと実測で固定する。
  - headless `result/end_turn`と同じ`session_id`の`--resume`、`SessionStart:resume`を確認した。backgroundは`--print`と両立せず、`claude --bg '<task>'`がjob handleを返す。`agents --json`、`logs`、`stop`で`busy/working → idle/done → stop`を回収できた。
- [x] ClaudeとCodexの候補が同じprojectにある場合のhost switchと曖昧性を固定する。

### Phase 1: Core projection

- [x] `src/observer-turn-feed.mjs`へproject resolver、completed chain、opaque cursorを実装する。
  - commit `def92f4`。Codexは自身の`task_complete`時刻だけを採用し、Claude receiptと共通のhash-only chainへ投影する。prior sourceのrollback／消失をswitchより先に検証する。
- [x] Claude Stop hookからbounded private completion receiptをatomic publishし、project digest、session、pair digest、sequenceを固定する。receipt失敗時はcursorを進めない。
  - project digestごとのprivate storeへ分離し、256件の履歴上限と`history_floor`をproject単位で保持する。同一origin/pairのStop再実行はsession mergeでtargetが変わっても再採番せず、DB capture成功後・L1/L3前に同期publishする。
- [x] host adapter境界を設け、Claude既存parserとCodex rollout parserのcompleted chainを共通projectionへ変換する。
- [x] empty baseline、same-thread append、thread switch、host switch、ambiguous parent、rollback、version mismatchを実装する。
- [x] DB freshness照合を既存`auditor-context` helperと共有し、重複した別仕様を作らない。
  - commit `022c0b8`。completed chainのorigin/user/assistant SHA-256をDBのcompleted pairへ順序付きで
    全件照合し、一件でも不足・不一致なら本文ゼロの`projection_pending`とする。schema/project/I/Oは
    hard failure、本文上限でもturn recordとdigestを保持し、raw session identityをpublic resultへ出さない。
- [x] Codex feedの`origin_sha256`をDB captureの`codex:<thread_id>` identityへ揃え、実DB fixtureで
  `projection_pending`へ固定されないことを回帰化する。
- [x] bounded snapshot、delta pagination、page token検証を実装する。
  - commit `7b07425`。初回through cursorで固定したlogical seriesだけをpage化し、project／exact
    after／exact through／offset prefix digestへtokenを束縛した。snapshotは最新limit件で完了し、
    deltaは途中の新規turnを混ぜず全件継続する。DB不足は本文・next token・through cursorを返さない。
    関連gateは36/36 green、Control `observer-feed-20260715` revision 26でimmutable ADR 0006へfinalizeした。

### Phase 2: CLI read / wait

- [ ] `observer-read`と厳格なJSON schema / exit契約を実装する。
- [ ] `observer-wait`の即時changed、待機changed、timeout、deadline再確認を実装する。
- [ ] SIGINT / SIGTERM / parent disconnectで待機を明示cancelする。
- [ ] CLI help、bin dispatch、import-safe testを追加する。
- [ ] 65秒超live waitと3600秒設定をblack-boxで確認する。

### Phase 3: Integration

- [ ] Observer fixtureからCLIだけを使うblack-box contract testを通す。
- [ ] Claude／CodexそれぞれのObserver fixtureで65秒超live waitと3600秒設定を確認する。
- [ ] Claude hook、Codex capture、auditor-context、token monitorの回帰を通す。
- [ ] README、CLAUDE.md、docs overview、CHANGELOGを実装済み挙動に同期する。
- [ ] `npm test`、`npm pack --dry-run --json`、`git diff --check`をgreenにする。
- [ ] 独立監査でin-flight混入、thread誤選択、cursor欠落、cancel leak、privacyを反証する。

## 受け入れ条件

1. project絶対pathだけから最新の完了済みClaude／Codex親hostとthreadを解決する。
2. Codexの`task_complete`またはClaudeの実証済み完了証拠より前のturnでcursorが進まない。
3. 呼出前に増えたturnはwaitが即時changedで返す。
4. 待機中に増えたturnは一回のwaitを完了させる。
5. timeout境界のturnを取りこぼさない。
6. 親thread作り直しを`thread_switched`、Claude／Codex間の移動を`host_switched`として返す。
7. rollback / prefix不一致を`resync_required`として返す。
8. DB lagを`projection_pending`として返し、stale本文をfresh扱いしない。
9. pagination中の新turnを固定`throughCursor`へ混ぜない。
10. 上限超過を黙ってdropしない。
11. cancel後にprocess、timer、DB handleが残らない。
12. ThroughlineのDB schema、既存Claude path、既存Codex captureを互換破壊しない。
13. Observer以外の利用者にも再利用できるJSON-only read / wait CLIになる。
14. 異なるhostの現在親を一意に解決できない場合は`ambiguous_parent`でfail closedにする。

## Rollback

新しいmodule、CLI dispatch、tests、docsだけを独立してrevertできる単位にする。既存DB migrationやhook shapeへ依存させない。ObserverはThroughlineの最低対応versionをverifyし、旧versionでDB直接監視へfallbackせず明示的に起動拒否する。
