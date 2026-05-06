---
description: 現セッションの context trim 計画を dry-run する (Throughline)
---

Throughline の context trim は、現時点では dry-run のみ有効です。自動 `/rewind` や自動 rollback / inject は、host primitive の検証が完了するまで実行してはいけません。

まず、今この時点の「現在作業」を自分の文脈から思い出し、以下 4 項目を Markdown で整理してください。

- **次の一手**: 今まさに何をやろうとしていたか（1-3 文、具体的に）
- **現在の方針 / 仮説**: 追っているバグの原因、設計の方向性、調査中の観点など
- **未解決の疑問**: 判断保留中の論点
- **進行中 TODO**: 完了済みを除いた現行 TODO

その Markdown を stdin として、次のコマンドを Bash ツールで実行し、結果をユーザーにそのまま要約してください。

```bash
throughline trim --dry-run --host claude --memo-stdin $ARGUMENTS <<'EOF'
**次の一手**: ...
**現在の方針 / 仮説**: ...
**未解決の疑問**: ...
**進行中 TODO**:
- ...
EOF
```

出力には以下が含まれます。

- 現セッションで Throughline が捕捉している turn 数
- keep-recent 設定
- rollback 候補 turn 数
- host が自動 rollback / inject 対応かどうか
- rollback 後に戻す curated memory preview
- rollback 後に「今やっている作業」として戻す current-work memo

`$ARGUMENTS` には `--keep-recent 20`、`--all`、`--session <id>` を渡せます。

重要:

- dry-run の結果だけで自動 rollback しないでください。
- Claude の既存 `/tl` baton handoff は変更しません。
- L1/L2 だけでは「今やっている作業」として認識されにくいので、current-work memo を省略しないでください。
- `Throughline Trim Dry-run` の `Automatic execution allowed` が `no` の場合は、実行手順ではなく「現状は dry-run / 手動案内まで」と説明してください。
