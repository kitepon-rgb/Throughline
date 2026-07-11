# Claude Code Hooks — SessionEnd reason enum (Extract)

Source: <https://code.claude.com/docs/en/hooks> (fetched 2026-07-11)
確度: 公式 docs verbatim（Matcher patterns テーブルより）。実機検証は Throughline docs/12 A Phase 1 spike で実施予定。

## SessionEnd

- SessionEnd イベントの matcher は「why the session ended」でフィルタする。
- **reason enum**: `clear` / `resume` / `logout` / `prompt_input_exit` / `bypass_permissions_disabled` / `other`
- `clear` = "Session cleared with /clear command"
- **デフォルト timeout は 1.5 秒**で /clear にも適用される（hook が 1.5 秒を超えるとサイレント kill）→ 登録時は per-hook timeout を明示すること。

## SessionStart source（同 fetch での再確認）

- `source` enum: `"startup"`（新規）/ `"resume"` / `"clear"`（/clear 後）/ `"compact"`

## Throughline 的含意（実測とセット）

- VSCode（2.1.195〜2.1.207 実測）は /clear で `source:"clear"` を送る。Desktop（2.1.205 実測）は `source:"startup"` を送る＝クライアント実装差（docs/12 §2）。
- ビルトイン /clear は UserPromptSubmit / UserPromptExpansion のどちらにも乗らない（UserPromptExpansion の対象は skill / custom command / mcp_prompt のみ）＝ /clear 検知は SessionEnd(reason='clear') が唯一の hook 経路候補。
- Desktop が SessionEnd(reason='clear') を実際に発火するかは未検証（2026-07-11 時点）。
