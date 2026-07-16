# ADR 0013: Observer readは同時writerをboundedに待つ

日付: 2026-07-16

## Status

Implemented。queue 19e実Codex candidateでの受入れ待ち。

## Context

queue 19eの実Codexで、2件目の`task_complete`とThroughline captureは成功した一方、同時に走った
Observer production callerの`observer-read`が一度nonzeroとなり`E_THROUGHLINE_EXEC`で終了した。
直後の同じ公開readは2件のcompleted turnを返した。campaign-private driverでも同じ書込み瞬間の
単発nonzeroを観測しており、caller固有の失敗ではない。

completed feedはDB lagを`projection_pending`として扱うが、SQLite lockをstale成功へ丸めてはならない。
一方、通常のStop captureとreadの短い競合を即時hard failureにすると、正規の継続監視が不安定になる。

## Decision

1. `readCompletedPairProjection`のread-only SQLite connectionだけにbounded busy waitを設定する。
2. lock解消後は同じDBの整合したsnapshotを読み、pair不足は従来どおり`projection_pending`にする。
3. busy上限超過、schema不一致、project不一致、その他I/Oは従来どおりhard failureにする。
4. CLI再spawn、別DB、古い本文、cursor進行へのfallbackは追加しない。
5. Spotter向け`readAuditorContext`の既存lock failure契約は変更しない。

## Acceptance

- 別processがexclusive writer lockを保持中でも、上限内に解放すればcompleted projectionが同じpairを返す。
- 上限を越えるlockとその他hard failureはnonzero契約を維持する。
- Observer read／wait、auditor-context、Codex captureの関連gateを一度通す。
- 修理済みcandidateでqueue 19e Codex 2-cycle liveを再確認する。

実装gate（2026-07-16）:

- focused `src/auditor-context.test.mjs`: 修正前15/16、修正後16/16 PASS。
- related Observer read／wait、auditor、receipt、Codex hook／capture: 78/78 PASS。
- 変更source／testの構文検査、新規ADR lint、`git diff --check`: PASS。
