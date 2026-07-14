# ADR 0005: Observer read seriesを固定through cursorとopaque page tokenへ束縛する

日付: 2026-07-15

## Context

Observerは監査対象の完了turnを複数pageで読む。一回のread series中にも親threadへ新しいturnが
追加され得るため、各pageでlatestを読み直すと途中から別の上限が混ざり、重複・欠落・未監査cursorの
保存が起きる。単純なoffsetだけのpage tokenは、別project、別after cursor、別through cursorへ
転用できる。

この裁定はControlのDecision証拠に使うため、追記可能な
`docs/14_observer_completed_turn_feed_plan.md`へ契約本文を追加せず、wave専用の不変ADRとして置く。

## Decision

1. Libraryは`readObserverTurnPage`を公開し、project、`afterCursor`、`throughCursor`、
   `pageToken`、`limit`と既存host/DB read optionsを受ける。`limit`は1以上100以下、既定10とする。
2. 最初のpageで`throughCursor`が無ければ、その呼出時点のcompleted-only chain上限を一度だけ固定する。
   続きのpageは同じ`afterCursor`と`throughCursor`を必須とし、途中で完了したturnを混ぜない。
3. page token schemaは`throughline.observer_page.v1`とし、canonical project SHA-256、
   exact after cursorのSHA-256（nullも固定表現でhash）、exact through cursorのSHA-256、
   0以上のsafe integer offsetを持つ。tokenはopaque、4 KiB以下、exact schemaで検証する。
   project path、本文、raw session/thread/origin ID、cursor本文は埋め込まない。
4. tokenは`pageToken`単独では使えない。呼出側が返送したproject、after、throughを再hashして
   tokenの束縛と完全一致させる。不一致、version違い、改変、範囲外offsetは`resync_required`へ
   丸めずhard input errorとして拒否する。
5. `afterCursor`と`throughCursor`はそれぞれ自身が指すsource chainのprefixとして再検証する。
   同一thread deltaでは`after.length..through.length`、host/thread switchでは新sourceの
   `0..through.length`だけを対象にする。afterより短いthrough、source rollback、source消失、
   project/version不一致は`resync_required`とし本文を返さない。
6. 初回snapshotは最新`limit`件だけを返し、より古い完了turnがあれば`historyTruncated=true`を
   明示してseriesを完了する。snapshotの過去分にはpage tokenを発行しない。
7. delta / host switch / thread switchで対象がlimitを超える場合だけpaginationする。
   `page.complete=false`では次offsetのtoken、最終pageでは`complete=true, nextToken=null`を返す。
   empty deltaも完了pageとして表現する。
8. DB projectionが一件でも不足・不一致なら`projection_pending`、`turns=[]`、next tokenなしを返す。
   部分pageを成功として返さず、Observerは保存済みafter cursorを進めない。schema/project/I/O異常は
   hard failureのままにする。
9. read wireは`throughline.observer_read.v1`、hash-only thread identity、status、after/through cursor、
   bounded turn records、`historyTruncated`、pageだけを返す。各turnは順序を維持し、本文がboundで
   truncateされてもturn recordとcontent digestを落とさない。
10. Observerは全pageの処理と監査が成功した時だけ`throughCursor`を保存する。crash、cancel、
    hard failure、`projection_pending`、`resync_required`では旧cursorを維持する。

## Consequences

- 新しい完了turnは進行中seriesへ入らず、次のwait/readで回収される。
- page tokenの別project／別seriesへの転用とoffset改変をfail closedにできる。
- snapshotはorientation用のbounded最新履歴、deltaは欠落のない全件paginationという役割に分かれる。
- DB本文が遅れてもcursor正本を偽装せず、部分監査済みの状態を成功扱いしない。
