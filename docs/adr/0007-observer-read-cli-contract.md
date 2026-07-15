# ADR 0007: observer-read CLIはJSON-only read境界と固定error codeを持つ

日付: 2026-07-15

## Context

ObserverはThroughlineの内部moduleやDBを直接読まず、公開CLIだけを子processとして呼ぶ。Libraryの
`readObserverTurnPage`は既知状態を値で返す一方、引数、page token、project、DB schema／project／I/Oの
hard failureは例外で拒否する。CLIが例外本文、path、session、cursor、本文をstderrへ出すとprivacy境界を
壊し、既知状態までnon-zeroへ丸めるとObserverがretry／resyncを正しく選べない。

この契約はControlのDecision証拠に使うため、追記可能な計画書ではなく不変ADRとして置く。

## Decision

1. 公開入口は次とし、`--project`と`--json`を必須にする。`--after-cursor`、`--through-cursor`、
   `--page-token`、`--limit`は各0回または1回だけ受理し、未知option、重複、値欠落、余剰位置引数を拒否する。

   ```text
   throughline observer-read --project <absolute-existing-directory>
     [--after-cursor <opaque>] [--through-cursor <opaque>]
     [--page-token <opaque>] [--limit <1..100>] --json
   ```

2. `--page-token`は`--after-cursor`と`--through-cursor`の両方がある場合だけ受理する。cursor／tokenの
   decode、project canonicalization、固定series検証はCLIへ複製せず`readObserverTurnPage`へ委ねる。
3. `snapshot`、`delta`、`thread_switched`、`host_switched`、`resync_required`、
   `projection_pending`、`ambiguous_parent`はすべて既知状態である。stdoutへ
   `throughline.observer_read.v1`を単一行JSONとして一度だけ出し、stderr空、exit 0とする。
4. hard failureはstdoutを空に保ち、stderrへ次の固定shapeを単一行JSONとして一度だけ出し、exit 1とする。
   error messageへ例外本文、path、body、cursor／token、hash、session／thread／origin IDを転記しない。

   ```json
   {"schema":"throughline.observer_read.v1","status":"error","code":"E_OBSERVER_READ_ARGS","message":"invalid observer-read arguments"}
   ```

5. 固定codeは次へ限定する。

   | 条件 | code | message |
   |---|---|---|
   | CLI構文、必須／重複option、limit形式 | `E_OBSERVER_READ_ARGS` | `invalid observer-read arguments` |
   | project／page tokenのhard input拒否 | `E_OBSERVER_READ_INPUT` | `observer read input is invalid` |
   | DB schema不一致 | `E_OBSERVER_READ_DB_SCHEMA` | `observer read database schema is unsupported` |
   | DB project不一致 | `E_OBSERVER_READ_DB_PROJECT` | `observer read database project does not match` |
   | DB open／query／I/O失敗 | `E_OBSERVER_READ_DB_IO` | `observer read database could not be read` |
   | 上記以外の内部失敗 | `E_OBSERVER_READ_INTERNAL` | `observer read failed` |

6. 公開CLIへ`--db`、`--codex-home`、receipt store path、raw session指定を追加しない。製品標準pathと
   host固有indexをlibrary既定で解決し、testはdependency injectionまたは隔離HOME／CODEX_HOMEを使う。
7. `bin/throughline.mjs`はsubcommandを明示dispatchし、返却exit codeだけを`process.exitCode`へ写す。
   import時にCLIを自動実行せず、parserと`run`はunit test可能に保つ。
8. cursorのversion、project、prefix、rollback不一致はLibrary既定どおり`resync_required`の既知状態で
   exit 0とする。page tokenのversion、binding、offset／prefix不一致だけはsilent skipを防ぐhard input
   errorであり、`E_OBSERVER_READ_INPUT`へ写す。

## Consequences

- Observerはstdoutだけを成功／既知状態wireとしてparseでき、stderrは固定codeのhard failureだけになる。
- DB遅延やresyncをprocess failureと誤認せず、page token改変やDB破損を成功JSONへ丸めない。
- 内部例外や端末固有pathがadapter境界から漏れない。
- waitのdeadline、poll、signal／parent disconnect契約は別ADR／Taskで扱い、read CLIへ混ぜない。
