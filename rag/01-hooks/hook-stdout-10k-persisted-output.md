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

## 追記: 10k 判定は per context string — multi-hook で突破可能（2026-07-18 実測、不採用）

同一イベントに複数 hook を登録した場合の挙動を実測した（Claude Code 2.1.211、
一時 project + 3〜5 本の UserPromptSubmit tracer hook + `claude -p` Haiku）:

- 各 hook stdout は**独立の `hook_success` attachment** になり、10k 判定も per string。
  3 本 × 9,000 字 = 27,000 字、5 本 × 9,000 字 = 45,000 字が全部モデル可視 inline
- 1 本だけ 12k にすると**その 1 本だけ**が `<persisted-output>` 化し、隣の 9k は無傷
- hooks reference の「10,000 characters per context string」「複数 hook の
  additionalContext は all of the values が届く」の文言と整合
- **罠**: attachment の並び順は登録順と一致しない（hook 並列実行のため非決定）。
  multi-part 注入に使うなら各 part に自己記述ヘッダが必須

Throughline では「hook の構造的想定（1 本 = 1 context string）に無い使い方」として
**不採用**（オーナー裁定 2026-07-18）。注入は 9,500 字 push + `throughline recall` pull の
二段構成にした（[ADR 0016](../../docs/adr/0016-push-pull-recall-injection.md)）。

## 検証手順（再現用）

1. 一時 project に `.claude/settings.json` で UserPromptSubmit hook を登録し、
   10k 境界の前後に tracer を置いた ~12k 字を stdout に emit する
2. `claude -p --model claude-haiku-4-5-*` で「見えている tracer を列挙して」と問う
3. transcript の `attachment.content` / `attachment.stdout` を比較する
