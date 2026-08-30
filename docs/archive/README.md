# docs/archive/

ここは完了済み計画、置換済み設計、過去の実装・受入記録の保管場所である。
現行仕様の入口ではなく、通常作業では読まない。現行文書は
[docs overview](../00_overview.md) から辿る。

## 完了済み計画・実装記録

| 文書 | 履歴として残す内容 |
|---|---|
| [02_clear_auto_handoff_plan.md](02_clear_auto_handoff_plan.md) | v0.4系のauto-handoff実装計画と当時のTODO |
| [03_inheritance_on_clear_only.md](03_inheritance_on_clear_only.md) | 2026-04 時点の handoff 方式検証 |
| [07_codex_trim_implementation_plan.md](07_codex_trim_implementation_plan.md) | Claude/Codex両対応とrollback trimの旧統合計画 |
| [10_transcript_injection_plan.md](10_transcript_injection_plan.md) | transcript injection経路の実機検証 |
| [11_codex_monitor_implementation_plan.md](11_codex_monitor_implementation_plan.md) | Codex monitor実装記録 |
| [12_desktop_clear_handoff_plan.md](12_desktop_clear_handoff_plan.md) | Desktop `/clear` の実測、NO-GO判断、L2 backfill実装・受入 |
| [13_native_factory_diagnostics_plan.md](13_native_factory_diagnostics_plan.md) | native factory diagnostics実装記録 |
| [14_observer_completed_turn_feed_plan.md](14_observer_completed_turn_feed_plan.md) | Observer completed-turn feedの設計・受入 |
| [15_windows_ci_release_latency_plan.md](15_windows_ci_release_latency_plan.md) | Windows CI latency修理・受入 |
| [16_readonly_handoff_context_plan.md](16_readonly_handoff_context_plan.md) | read-only handoff-context v0.9.0設計・受入 |
| [BUGHUB_RUNTIME_ERROR_STORE_PLAN.md](BUGHUB_RUNTIME_ERROR_STORE_PLAN.md) | local runtime error store実装計画 |
| [plan_grok-successor-launch.md](plan_grok-successor-launch.md) | Grok successor launch v0.10.0設計・受入 |
| [room-log_throughline_20260830-155052.md](room-log_throughline_20260830-155052.md) | Grok successor launch時のPeertable円卓ログ |

## 置換済みの初期資料

| 文書 | 履歴として残す内容 |
|---|---|
| [CONCEPT.md](CONCEPT.md) | judgments tableを想定した初期コンセプト |
| [EXPERIMENT.md](EXPERIMENT.md) | `/clear` 跨ぎのsession linking実験 |
| [SESSION_LINKING_DESIGN.md](SESSION_LINKING_DESIGN.md) | 置換済みのファイルベース紐付け設計 |
| [THROUGHLINE_NEXT_STEPS.md](THROUGHLINE_NEXT_STEPS.md) | v0.1.0公開前の優先順位メモ |

履歴から得た現行判断は、README、CLAUDE.md、現行docs、ADRへ統合する。
archive文書を更新して現行契約へ戻さない。
