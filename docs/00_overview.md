# Throughline Documentation Overview

このディレクトリは Throughline の設計・計画・監査記録の入口です。実装判断は常に source を正とし、文書は現行実装へ追従させます。

## Canonical Docs

| 文書 | 役割 |
|---|---|
| [01_l1_l2_l3_redesign.md](01_l1_l2_l3_redesign.md) | L1/L2/L3 記憶レイヤーの設計記録 |
| [02_clear_auto_handoff_plan.md](02_clear_auto_handoff_plan.md) | `/clear` / `/tl` handoff の現行仕様と計画 |
| [03_inheritance_on_clear_only.md](03_inheritance_on_clear_only.md) | 2026-04 段階の継承方式検証履歴 |
| [04_public_release_plan.md](04_public_release_plan.md) | 公開配布化、フォールバック禁止、リリース状態 |
| [05_codex_first_roadmap.md](05_codex_first_roadmap.md) | Codex primary / trim / Claude finalization の実装順 |
| [06_codex_trim_rollback_fix_plan.md](06_codex_trim_rollback_fix_plan.md) | Codex rollback / inject incident 後の修正計画 |
| [07_codex_trim_implementation_plan.md](07_codex_trim_implementation_plan.md) | Codex 両対応 + rollback trim の旧統合計画と実装履歴 |
| [08_codex_dual_support.md](08_codex_dual_support.md) | Claude primary を維持した Codex adapter 方針 |
| [09_rollback_context_trim_insight.md](09_rollback_context_trim_insight.md) | rollback を context delete primitive と見る設計メモ |
| [10_transcript_injection_plan.md](10_transcript_injection_plan.md) | transcript injection 検証計画と v0.5 実機結果 |
| [11_codex_monitor_implementation_plan.md](11_codex_monitor_implementation_plan.md) | Codex monitor 対応の実装記録 |
| [13_native_factory_diagnostics_plan.md](13_native_factory_diagnostics_plan.md) | native factory read-only readiness 診断の実装記録 |
| [14_observer_completed_turn_feed_plan.md](14_observer_completed_turn_feed_plan.md) | Observer向けcompleted-only read / wait CLIのactive計画。CLI・opaque cursor・pagination・最大3600秒waitは実装済み、公開／full regression gateは継続中 |
| [15_windows_ci_release_latency_plan.md](15_windows_ci_release_latency_plan.md) | Windows CI 18分の原因、ACL安全網を維持した短縮、release gateの受入条件 |
| [BUGHUB_RUNTIME_ERROR_STORE_PLAN.md](BUGHUB_RUNTIME_ERROR_STORE_PLAN.md) | local runtime error aggregate store の契約と実装 TODO |

## Supporting Records

| 場所 | 役割 |
|---|---|
| [adr/](adr/) | 根幹の設計判断 |
| [audit-2026-05/](audit-2026-05/) | 2026-05 の監査・インシデント記録 |
| [archive/](archive/) | 破棄または履歴扱いの旧設計 |
| [../rag/INDEX.md](../rag/INDEX.md) | 外部仕様・調査の再利用棚 |

現行ADR:

- [ADR 0001](adr/0001-claude-primary-codex-adapter.md): Claude primaryを維持し、Codexをadapterとして追加する。
- [ADR 0002](adr/0002-observer-claude-completion-receipt.md): Claude completed turnはThroughline所有のStop receiptで固定する。
- [ADR 0003](adr/0003-observer-completed-chain-cursor.md): Observer cursorをhost固有のcompleted pair chainとprefix検証へ束縛する。
- [ADR 0020](adr/0020-windows-ci-release-latency.md): Windows ACL契約を維持し、境界fixtureと実ACL検証を分離する。

Observerの公開境界は`throughline observer-read`／`throughline observer-wait`のJSON-only CLIである。
ThroughlineはClaude Stop receiptとCodex rolloutの`task_complete`だけからcompleted cursorを構築し、
ObserverがDB、WAL、rolloutを直接監視するfallbackは持たない。waitは最大3600秒で、`changed`、`timeout`、
`resync_required`、`ambiguous_parent`を返す。

## Entrypoints

- [../CLAUDE.md](../CLAUDE.md): AI 作業者向けの正本。
- [../README.md](../README.md): ユーザー向けの入口。
- [../AGENTS.md](../AGENTS.md): Codex など Claude Code 以外のエージェント向け入口。
