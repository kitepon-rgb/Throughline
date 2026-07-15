# ADR 0011: Observer O1 Controlのclosure laneを補正する

日付: 2026-07-15

## Status

Accepted

## Context

Control `observer-feed-20260715`のPhase gateは、O1の主要実装Taskが完了したrevision 51の後、
revision 52で`behavior-preserving`として宣言された。したがって、このgateが対象にするのは
文書同期、full/pack、独立監査、最終統合からなるclosure laneであり、先行するO1実装全体を
behavior-preservingと再分類するものではない。

独立監査後、P1/P2の挙動修正がclosure中に必要になった。元gateを改変したり
`behavior_change=not-applicable`のまま修正を隠したりしてはならない。

## Decision

1. P1/P2の修正受入はcorrective Control `observer-feed-o1-audit-fixes-20260715`が所有する。
2. corrective Controlは`behavior-change` laneで、二つの修正受入Task、focused gate、
   [ADR 0010](0010-observer-o1-phase-acceptance.md)をDecision証拠としてrevision 15でfinalize済みである。
3. 元ControlのPhase gateはrevision 52以降のclosure統合だけを対象とし、
   `behavior_change=not-applicable`はこのclosure laneに対してのみ記録する。
4. 元Controlの独立監査FAILEDとworker rejectは保持し、corrective Controlのfinalizationを受けて
   Phase O1全体を最終受入する。
5. Phase gateを実装後に追加した事実は消さない。今後のPhaseは実装前にgateを宣言する。

## Consequences

- 挙動修正をbehavior-preservingへ偽装せず、二つのControlの所有境界が明示される。
- 元Controlはclosure laneとして完了でき、O1の実装・監査・修正証拠を一つのDecision鎖へ統合できる。
- このADRを元ControlのPhase gateとControl finalizationの不変Decision証拠に使う。
