# Throughline: ロールバックによるコンテキスト整理の気づき

## この文書の位置づけ

この文書は **rollback-based context trim の設計メモ** です。

関連文書:

| 文書 | 役割 |
|---|---|
| [THROUGHLINE_CODEX_FIRST_ROADMAP.md](THROUGHLINE_CODEX_FIRST_ROADMAP.md) | 2026-05-06 以降の次フェーズ計画。Codex primary と Codex Rewind 互換を先行する |
| [THROUGHLINE_CODEX_TRIM_ROLLBACK_FIX_PLAN.md](THROUGHLINE_CODEX_TRIM_ROLLBACK_FIX_PLAN.md) | 2026-05-06 incident 後の修正計画。2026-05-08 の controlled smoke 後、automatic mutation は再有効化し、restore-safety / host primitive audit は diagnostics として残す |
| [THROUGHLINE_CODEX_TRIM_IMPLEMENTATION_PLAN.md](THROUGHLINE_CODEX_TRIM_IMPLEMENTATION_PLAN.md) | この気づきと Claude / Codex 両対応計画を統合した旧計画と実装履歴。完了済み根拠として参照する |
| [THROUGHLINE_CODEX_DUAL_SUPPORT.md](THROUGHLINE_CODEX_DUAL_SUPPORT.md) | Throughline を Claude primary のまま Codex adapter / sidecar に対応させる architecture brief |

この文書は「rollback は欠けていた delete primitive かもしれない」という洞察を残すもの。実装時は、未検証の host primitive を本線仕様にせず、次フェーズ計画 [THROUGHLINE_CODEX_FIRST_ROADMAP.md](THROUGHLINE_CODEX_FIRST_ROADMAP.md) の Codex Rewind 互換 Phase で実測してから本線 UX に進む。

2026-05-06 update: Codex app-server の `thread/rollback` / `thread/inject_items` は live host primitive として実測済み。Throughline CLI には明示 `--codex-thread-id` または `THROUGHLINE_CODEX_THREAD_ID` / `CODEX_THREAD_ID` による current-thread identity、rollout/app-server turn count guard、guarded execute が入った。

2026-05-07 correction: VS Code restart / reconnect 後に rollback 済み user prompt が復活したように見える incident が起きたため、Codex rollback / inject は restart-safe な context trim primitive としていったん未証明へ戻した。特に `compacted.replacement_history` など、live app-server read/resume 以外の restore source を検証するまで、`$throughline` と Codex Stop hook auto-refresh は mutation を自動実行しない方針にした。Claude `/rewind` 自動化はまだ有効化しない。

2026-05-08 unblock: その後の切り分けで、incident thread の retained text は app-server response 上では `aggregatedOutput` など quoted/tool-output field に分類され、controlled rollback model-visible smoke は app-server restart 境界と VS Code reload/reconnect 境界の両方で `not-reproduced` だった。これを受け、Codex `trim --execute --host codex` と Stop hook auto-refresh の過剰 blocker は解除する。`compacted.replacement_history` retention、restore-safety risk、host primitive audit は引き続き diagnostics だが、単独では mutation 前 refusal にしない。DB memory 不在と rollout/app-server turn-count 不一致は引き続き mutation 前 blocker。

2026-05-09 skill UX: bare `$throughline` は diagnostics / dry-run / preflight を AI に順番実行させる surface ではなく、`throughline trim --execute --host codex --all --json` を直接走らせる scripted current-thread refresh とする。目的は rollback と、Throughline DB の L2 最新 20 full bodies + older L1 summaries + L3 references-only memory injection のみ。doctor / dry-run / preflight / fresh-thread handoff / restore-safety / host primitive audit は明示診断用であり、通常 `$throughline` の前段にはしない。

2026-05-07 host primitive audit: `throughline codex-host-primitive-audit` で installed Codex app-server schema を機械監査した。`thread/rollback` / `thread/inject_items` / `thread/compact/start` / `thread/start` / `thread/fork` / `thread/resume` は存在するが、rollback 済み user text を current-thread の model-visible input へ復活させない deletion / isolation / projection primitive は見つからなかった。`thread/resume(history)` は schema 上 `[UNSTABLE] FOR CODEX CLOUD - DO NOT USE` で、`thread_id` も ignored になるため、Throughline の current-thread repair primitive には採用しない。

## 概要

Throughline はもともと、ホスト側の制約に対する回避策として作られた。

- Claude Code は、蓄積されたモデル可視コンテキストをユーザーが直接編集できなかった。
- 長いセッションでは、重い tool I/O がコンテキストの大部分を占める。
- `/clear` や新規セッションでは、有用な作業記憶まで失われる。
- Throughline は、有用な記憶を外部DBへ保存し、明示的な baton によって次セッションへ引き継ぐことでこれを解決した。

今日の重要な気づき:

> conversation-only rollback が使えるなら、rollback は「欠けていた delete primitive」になる。

これにより、Throughline の将来像が変わる可能性がある。

従来:

```text
旧セッション
  -> /tl baton
  -> /clear または新規セッション
  -> 次セッションが curated memory を受け取る
```

新しい可能性:

```text
同一セッション / 同一スレッド
  -> 全turn履歴を Throughline DB に保存
  -> conversation context を開始直後まで rollback
  -> curated L1/L2 memory を再注入
  -> 同じセッション / スレッドで続行
```

これが成立すると、Throughline は「セッション間ハンドオフツール」から、「モデル可視コンテキストの外部マネージャ」へ進化できる。

## なぜ重要か

元の Throughline 設計は間違っていたわけではない。ホスト側に制約があった。

本質的な問題は「セッションをまたぐ必要があること」ではなく、次の一点だった。

```text
モデルが見る蓄積コンテキストを、ユーザーが直接編集できない。
```

Throughline はこの問題を、記憶をホストの外へ逃がすことで解いた。

- L1: 古いturnの一行要約
- L2: 最近の user / assistant テキスト
- L3: tool I/O、コマンド出力、thinking、system/tool noise などの重い詳細

重要なのは、Throughline が価値ある記憶を SQLite に保持していること。

もしホストが conversation-only rollback を提供するなら、Throughline は rollback を使ってモデル可視履歴を削除し、自前DBから必要な記憶だけを戻せる。

## 標準コンパクションのもったいなさ

標準 compaction は便利だが、Throughline の目的とは相性が悪い。

Throughline が避けたいのは、重い tool I/O をもう一度モデルに読ませること。

標準 compaction は多くの場合、次のような流れになる。

```text
重い蓄積コンテキスト
  -> モデルに送る
  -> モデルが要約する
  -> 軽いコンテキストとして残す
```

つまり、トークンを節約するためにトークンを燃やす。

Throughline では、必要な記憶はすでに構造化して保存されている。

- user / assistant text はそのまま保存できる
- tool I/O は SQLite に退避できる
- summary は lazy に作れる
- detail は必要なときだけ取り出せる

したがって理想は「現在のコンテキストを要約する」ことではない。

理想はこれ。

```text
現在の model-visible context を、モデルに再読させずに削除または置換する。
```

## 欲しいプリミティブ

理想のホストAPIは、たとえば次のようなもの。

```text
thread/context/replace
```

または:

```text
thread/context/edit
```

ほしい意味論:

- UI履歴は残す
- audit log / transcript / rollout record は残す
- ローカルファイル変更は維持する
- 次回モデルへ渡す履歴だけを置換する
- 外部ツールが生成した memory items を受け取れる
- rollback / restore 用のメタデータを残せる

つまり:

```text
UI履歴は残る。
詳細ログも残る。
Throughline DBも残る。
次の model input だけが変わる。
```

## Codex で見えたこと

Codex には、関連する app-server primitive がいくつかある。

Codex CLI / app-server documentation から確認できたもの:

- `thread/read`
- `thread/turns/list`
- `thread/compact/start`
- `thread/rollback`
- `thread/inject_items`
- `turn/start`
- `turn/steer`
- `thread/resume`
- `thread/fork`

重要な挙動:

- `thread/compact/start` は、同一 thread の手動 history compaction を起動する。
- `thread/inject_items` は、raw Responses API items を loaded thread の model-visible history へ追加する。
- `thread/rollback` は、最後の N turns を agent の in-memory context から落とし、future resume でも pruned history が見えるよう rollback marker を永続化する。
- `ThreadRollbackParams` は `threadId` と `numTurns` だけを持つ。
- rollback の説明では、thread history のみを変更し、ローカルファイル変更は戻さないとされている。

つまり Codex の `thread/rollback` は、かなり conversation-only rollback に近い。

2026-05-06 の実測:

- Codex CLI `0.128.0-alpha.1` で `stdio://` app-server は newline-delimited JSON request / response で操作できた。
- `thread/read includeTurns:true` は persisted thread を読める。
- `thread/rollback` は loaded thread にだけ効く。persisted thread に直接呼ぶと `thread not found`。
- `thread/resume` 後に `thread/rollback { numTurns: 1 }` を呼ぶと、1 turn の検証 thread は 0 turns になった。
- rollback 後に `thread/inject_items` へ developer message item を入れ、次の `turn/start` で marker `TL_PHASE6_INJECT_OK` が model-visible になった。
- rollout JSONL には injected item が developer role の response item として記録された。

残る未検証は、複数 turn の partial rollback、rollback marker の resume 後挙動、ローカルファイル変更が戻らないことの実ファイル付き smoke、UI 表示差分。

参考:

- <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- <https://pkg.go.dev/github.com/tta-lab/codex-server-go/protocol#ThreadRollbackParams>

## Claude で見えたこと

Claude Code にも rollback / rewind mechanism がある。

Claude Code の `/rewind` は以下をサポートする。

- conversation only restore
- code only restore
- both code and conversation restore
- selected point 以降の summarize

つまり Claude には、手動UXとして conversation-only rollback がすでにある。

参考:

- <https://code.claude.com/docs/en/checkpointing>

違いは、自動化できる表面にありそう。

- Claude は `/rewind` による手動UXが強い。
- Codex は `thread/rollback` が app-server/API primitive として見えているため、外部ツールから自動化しやすい可能性がある。

概念的な綺麗さは、Claude も Codex も同じ。

## 新しい中核アーキテクチャ

新しいアーキテクチャ:

```text
host session / thread
        |
        v
Throughline event / log watcher
        |
        v
Throughline SQLite DB
  - L1 skeletons
  - L2 bodies
  - L3 details
        |
        v
conversation-only rollback
        |
        v
curated memory injection
        |
        v
same session / thread continues
```

ホストの session は作業の器になる。

Throughline DB は永続記憶になる。

rollback は delete operation になる。

injection は restore operation になる。

## Codex 候補フロー

Codex で考えられる流れ:

```text
1. Throughline が Codex log または app-server events から各turnを捕捉する。
2. Throughline が thread_id、turn index、timestamp、text、details を記録する。
3. ユーザーまたは自動処理が /tl-trim を起動する。
4. Throughline が現在 thread の保存済みturn数を数える。
5. Throughline が L1/L2/L3 から curated context を組み立てる。
6. Codex app-server に以下を送る。
     thread/rollback { threadId, numTurns: saved_turn_count }
7. Codex の model-visible history が pruned される。
8. Throughline が以下を送る。
     thread/inject_items { threadId, items: curated_memory_items }
9. ユーザーは同じ Codex thread で続行する。
```

現行実装では、Codex Stop hook 後の 90% automatic refresh は guarded rollback / inject
mutation を試行する。明示 CLI の `throughline trim --execute --host codex --codex-thread-id <id>`
も env gate なしで実行する。明示 Codex thread identity、injectable Throughline DB memory、
rollout/app-server turn count guard は live mutation の最低条件であり、durable success は
post-execute rollout evidence で `execute-durable-verified` として別判定する。

重要な考え:

```text
Throughline は毎turnを記録しているため、安全に rollback できる最大turn数を自分で知っている。
```

ただし、L1 / L2 を戻すだけでは足りない。

初期 Throughline で実際に落とし穴になったのは、「DB から L1 / L2 は確かに引き継がれるが、モデルがそれを **今やっている作業** として認識しない」ことだった。現行 `/tl` はこの問題を、旧セッションの Claude 自身に in-flight memo（次の一手 / 方針 / 未解決 / TODO）を書かせ、その memo を resume context の先頭に置くことで解消している。

ただし、memo を先頭に置くこと自体が唯一のスマートな解ではない。Claude / Codex の通常 context では、任意の text に「これは今取り込み中」という隠し属性が付くわけではなく、role / instruction authority、現在 turn への近さ、section boundary、metadata、最新 user request との接続によって、モデルが作業文脈として読む。したがって Throughline は、rollback 後に注入する curated memory を「過去ログ」ではなく「現在タスクに使う作業コンテキスト」として明示し、冒頭と末尾の両方に読み方を置く必要がある。

`/tl-trim` でも同じ制約を維持する。rollback 後に注入する curated memory は、L1 / L2 / L3 references だけでなく、current-work memo、active work thread framing、後続行優先 / supersession rule を含める。これを省くと、trim 後のモデルは「過去ログは読めるが、作業の続きとして走れない」状態に戻る。

## Claude 候補フロー

Claude で考えられる流れ:

```text
1. Throughline が hooks / transcript processing で毎turnを捕捉する。
2. ユーザーが trim operation を起動する。
3. Claude conversation を conversation-only rewind で戻す。
4. Throughline が curated context を再注入する。
5. ユーザーは同じ Claude session で続行する。
```

未解決なのは、Claude の conversation-only rewind を外部ツールから綺麗に自動化できるか。

できない場合、UX は手動寄りになる。

```text
/rewind conversation only
/tl restore
```

または Throughline がこの手順をユーザーに案内する。

## Throughline がすでに重要データを持っている理由

Throughline は毎turnを捕捉する。

したがって次の情報を知っている。

- current session id
- current thread id
- captured turn count
- どのturnが L1 / L2 / L3 か
- どの details が退避済みか
- 安全に rollback できる最大深度
- 再開に必要な curated memory

これは rollback-based trimming に必要な情報そのもの。

rollback 後にホストがすべてを覚えている必要はない。Throughline が覚えている。

## 設計の変化

旧アイデンティティ:

```text
Throughline は、セッション間の明示的ハンドオフシステム。
```

新しい可能性:

```text
Throughline は、model-visible context の外部マネージャ。
```

旧中核操作:

```text
memory を保存する
  -> clear / new session
  -> memory を注入する
```

新中核操作:

```text
memory を保存する
  -> conversation を rollback する
  -> memory を注入する
```

これは大きなUX改善になる。

- 新規セッションが不要
- 通常ケースでは session baton が不要
- 標準 compaction によるトークン消費が不要
- current session / thread に閉じるため、誤継承が起きにくい
- 詳細記憶は必要なときだけ取得できる

## 重要な注意点

まだ検証が必要なこと。

Codex:

- 複数 turn thread で `thread/rollback` の partial `numTurns` が期待通りに効くか。
- `thread/rollback` は thread 内の全turn数と同じ `numTurns` を受け入れるか。単一 turn の full rollback は成功済み。
- `thread/inject_items` は次の model-visible context に確実に入るか。developer message item では成功済み。
- `thread/inject_items` が受け付ける Responses API item 形式の許容範囲は何か。developer message item は成功済み。
- rollback 後、UI履歴はどう見えるか。消えるのか、marker付きで残るのか。
- rollback marker は `thread/resume` 後も期待通りに効くか。
- full rollback が token accounting を壊したり、不要な auto-compaction を誘発しないか。
- 実行中turnでも可能か、それとも idle 状態でのみ可能か。

Claude:

- `/rewind` conversation-only を自動化できるか。
- VS Code extension でも十分な制御ができるか、それとも CLI が必要か。
- 新規セッションなしで Throughline memory を再注入できるか。
- UI automation に頼らず、安全で反復可能な操作にできるか。

## コマンド候補

将来のコマンド名候補:

```text
/tl-trim
/tl-prune
/tl-rollback
/tl-repack
/tl-context
```

想定する意味:

```text
/tl-trim
  現在状態を Throughline DB に保存する。
  model-visible conversation を安全な範囲まで rollback する。
  curated memory を注入する。
  同じ session / thread で続行する。
```

バリエーション候補:

```text
/tl-trim --keep-recent 20
/tl-trim --all
/tl-trim --dry-run
/tl-trim --detail-on-demand
/tl-trim --no-summary
```

## 次の作業

推奨する次の検証:

1. 小さな Codex app-server integration harness を Throughline 側に作る。
2. test thread を開始し、数turn実行する。
3. turn を最小Throughline風DBまたはJSONへ捕捉する。
4. `thread/rollback` を partial `numTurns` で呼ぶ。
5. `thread/rollback` を full `numTurns` で呼ぶ。
6. rollback 後に `thread/read includeTurns:true` を確認する。
7. rollback 後の rollout JSONL を確認する。
8. `thread/inject_items` に simple curated memory item を渡す。
9. 新しいturnを開始し、モデルが injected memory を見ているか確認する。
10. rollback + injection 後の resume 挙動を確認する。

成功条件:

```text
full または near-full rollback が動く。
ローカルファイル変更は維持される。
injected curated memory が次の model turn から見える。
Throughline が対象 Codex thread を明示的に識別でき、誤 thread を rollback しない。
標準 compaction は不要。
同じ thread / session で続行できる。
```

これが通るなら、Throughline は session handoff を超えて進化できる。

## 一行の気づき

```text
Rollback is the missing delete primitive.
```

日本語で言うなら:

```text
ロールバックは、欠けていた「削除」プリミティブだった。
```
