# Hook stdout は約 10k 字で `<persisted-output>` に file 化され、モデル可視は先頭 2KB に劣化する

- **出典**: 自前実測（tracer 実験 + 全 transcript 掃引）。このMac、Claude Code 2.1.211
- **取得日**: 2026-07-17
- **確度**: confirmed（境界2点 + 実運用12件で再現）

## 事実

SessionStart / UserPromptSubmit の hook **plain stdout**（および文書上は
`hookSpecificOutput` の context string）は、約 10,000 字を超えると inline 注入されず、
transcript の `attachment.content` が以下に置換される:

```
<persisted-output>
Output too large (11.7KB). Full output saved to: ~/.claude/projects/<proj>/<session>/tool-results/hook-<uuid>...
<先頭 ~2KB の preview>
...
</persisted-output>
```

- 全文は attachment の `stdout` field に保存されるが、**モデル可視は `content`
  (= path + 先頭 2KB preview) だけ**。モデルがツールでファイルを読まない限り本文は届かない。
- 境界実測: **9,501 字は inline 通過 / 15,286 字は file 化**（公称上限は hooks reference の
  「10,000 characters per context string」と整合）。
- tracer 実験: 11,953 字 stdout の 10k 境界後 tracer は Haiku から不可視、境界前 tracer は可視。

## 影響（Throughline での実害）

実運用 transcript 掃引の結果、SessionStart 注入で 10k 超だった **12 件（2026-06-28 /
v2.1.195 以降の全件）が 12 件とも劣化**していた（例: 64,148 字 emit → 可視 2,054 字）。
記憶注入の L1+L2 本体はモデルに読まれておらず、ヘッダ + 現在地アンカーが偶然先頭 2KB に
収まっていたため「機能している風」に見えていた。

v2.1.195 より前に 10k 超を emit した実績が手元に無いため、「いつ導入されたか」は未確定。
運用上は「現行版では 10k 超 = 劣化」で確定。

## 対処

注入は予算内レンダリングで行う（Throughline は `buildBudgetedResumeContext`、上限 9,500 字。
ヘッダ + アンカー常時全文、L1 → L2 を新しい側から詰め、省略は注入文へ明示）。
詳細は [ADR 0014](../../docs/adr/0014-two-phase-handoff-ghost-baton.md)。

## 検証手順（再現用）

1. 一時 project に `.claude/settings.json` で UserPromptSubmit hook を登録し、
   10k 境界の前後に tracer を置いた ~12k 字を stdout に emit する
2. `claude -p --model claude-haiku-4-5-*` で「見えている tracer を列挙して」と問う
3. transcript の `attachment.content` / `attachment.stdout` を比較する
