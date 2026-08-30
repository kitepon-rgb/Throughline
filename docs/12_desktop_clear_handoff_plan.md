# 12 — Desktop `/clear` handoff（互換入口）

この計画は 2026-07-12 に完了した。実装・実測・NO-GO判断・0.6.0公開までの記録は
[archive/12_desktop_clear_handoff_plan.md](archive/12_desktop_clear_handoff_plan.md) に移した。

現行契約は [02_clear_auto_handoff_plan.md](02_clear_auto_handoff_plan.md) を正とする。
Claude Desktop は `SessionStart source='clear'` を送らないため、組み込み `/clear` の前に
`/tl` を実行する。VS Code は `source='clear'` の auto path を使う。
