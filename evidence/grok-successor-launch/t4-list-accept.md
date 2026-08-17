# t4-list-accept 証跡

担当: hikari  
plan: `grok-successor-launch`  
日付: 2026-08-17

## 何を測ったか

新席がトップレベル session として見えることを実測した。

起動は `throughline grok-continue --session grok:5d0ed78d-75c3-457e-8048-19a7e7daf05a`。
これは t3 が Grok `/tl` 成功後に副作用で呼ぶのと同じ CLI。aiterm は使わない。
Desktop の Inactive 畳みは成功条件にしない。

## 試験内容

1. spawn 前の `~/.grok/sessions/%2FUsers%2Fkite%2FDeveloper%2FThroughline/` に `cd90332a-e24c-4ddc-86a0-9279753221fc` が無いこと
2. `grok-continue` が exit 0 で stdout に `grok:cd90332a-e24c-4ddc-86a0-9279753221fc` を出すこと
3. 新席ディレクトリが cwd 直下のトップレベルとして現れること。他 session の子ではない
4. `summary.json` に `subagent` / `parent` / `parent_session` / `delegation` キーが無いこと
5. `grok sessions list` に同じ UUID が `local` として並び、subagent / Inactive 印が無いこと
6. `grok sessions search cd90332a` が 1 件で同じ UUID を返すこと（`--resume` が参照する同一 id 空間）

## 試験結果

1. PASS。spawn 前の listing に当該 UUID は無い
2. PASS。exit 0、stdout `grok:cd90332a-e24c-4ddc-86a0-9279753221fc`
3. PASS。パスは
   `~/.grok/sessions/%2FUsers%2Fkite%2FDeveloper%2FThroughline/cd90332a-e24c-4ddc-86a0-9279753221fc/`
   `find` の depth 3 でもこの1箇所だけ。入れ子なし
4. PASS。`summary.json` のキーに subagent / parent / parent_session / role / delegation は無い。`info.id` は当該 UUID、`info.cwd` は `/Users/kite/Developer/Throughline`
5. PASS。`grok sessions list -n 30` の行:
   `cd90332a-e24c-4ddc-86a0-9279753221fc  2026-08-17  2026-08-17  local  (no summary)`
   STATUS は `local`。subagent / Inactive 列も印も無い
6. PASS。`grok sessions search cd90332a -n 5` は
   `cd90332a-e24c-4ddc-86a0-9279753221fc (score: 1.00)` の 1 件

実装変更なし。対話の `grok --resume` picker は TTY を占有するので開いていない。一覧の正は session ディレクトリと、同じ id 空間の `grok sessions list`。
