# Grok successor launch — Throughline 所有の最小起動

Date: 2026-08-17  
Status: Accepted（v0.10.0）  
Lattice plan: `grok-successor-launch`  
対象 repo: Throughline だけ。aiterm は依存にも実装の借り先にもしない。

t1-contract（2026-08-17）で起動核の CLI名・初手文面・非目標・受入を固定した。
以降の工程は本ファイルと [ADR 0021](adr/0021-grok-host-capture.md) の現在地を正とする。

2026-08-17 実機: Dotagents 棚の `grok:01a00ff1-3f97-70e2-ba76-5acd90561a84` で
`handoff-context` が `ready` のあと `/tl`。後継
`~/.grok/sessions/%2FUsers%2Fkite%2FDeveloper%2Fdotagents/c01a2689-5b4f-4977-97ce-f73fcf317f94/`
が立ち、初手末尾は待機行、モデルは仕事を始めず待った。源の `merged_into` 空席
（`01a00b38`、L2 0 件）では spawn しない。

## 目的

Grok Desktop の UserPromptSubmit はモデルへ本文を渡せない。`/tl` のあと人が新窓を開いても記憶は載らない。代わりに Throughline 自身が、handoff-context を**最初の user 文の前**に置いた普通の Grok 席を一本立てる。

## 非目標

次は成功条件にも実装手段にもしない。

- aiterm / tmux / PTY 完了待ち / `role=subagent` を Throughline に持ち込む
- `grok` 起動に `--rules` を付ける（dashboard の top-level から外れる）
- `--system-prompt-override` / `--agent` で初手 user 文を代替する
- Claude / Codex の `/tl` 契約を変える
- UserPromptSubmit stdout や `chat_history.jsonl` への再注入で Desktop 新窓を直す
- 実装キャンペーン中の Spotter 作業（npm 公開は製品完遂であり禁止ではない）

## 固定契約

### CLI

名前と引数は次に固定する。

```
throughline grok-continue --session <id>
```

- `<id>` は Throughline の session id であり、Grok 由来なら `grok:` 接頭辞を含む。
- 既存の `handoff-context --session` と同じ flag 名を使う。`--from` は採用しない。
- この CLI は `handoff-context --session <id> --json` を読む。`status` が `ready` でない、終了が非 0、または context が空なら **spawn しない**。fallback 禁止。
- JSON envelope（`schema` / `status` / `sessionId`）は初手文へ載せない。載せるのは `context` 文字列だけ。

### spawn

- 源セッション（`--session` の Throughline 行）の `project_path` で立てる。呼び出し元の cwd は使わない。`project_path` が無い・読めない・ディレクトリが無いときは spawn しない。
- 共有 `GROK_HOME`（上書きしない）のまま `grok` を人の席として立てる。
- 起動は対話セッションである。`-p` / `--prompt` / `--prompt-file` / `--prompt-json` の単発終了経路は使わない。
- 初手は `grok` の位置引数 `[PROMPT]` に渡す。`--rules` は付けない。
- hook から呼ぶので対話 TTY は無い。macOS では新しい Terminal 窓で grok を前面に出す。立てた session id が分かれば標準出力にも出す（`grok --resume` できるようにする）。両方できることが受入の強い形である。

### 初手文面

初手 user 文は次の 4 段だけとする。前後の飾り文を足さない。`{context}` は handoff-context が返した `context` 文字列そのもの。末尾の待機が無いと、要約を新しい仕事の着手と誤る。

```
この発言は直前 Throughline 席の履歴を前提とする。

{context}

直前の作業の自然な続きとして応答すること。

この後ユーザーが指示を出す。何もせず待機すること。
```

### `/tl` 配線

- Grok envelope の `/tl` 成功後に、上記 CLI を副作用で起動する。baton は今どおり書く。
- Claude / Codex ではこの CLI を起動しない。

### 一覧

- 新席は `~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/` にトップレベルとして残る。
- aiterm の Inactive/subagent 隠しを再現しない。
- Desktop roster が別プロセスを Inactive に畳むのは Grok 側の仕様。受入は session ディレクトリと `grok --resume` 一覧を正とする。

## 受入

### focused（t2 / t3）

- `handoff-context` 失敗では `grok` を spawn しない。
- 初手文面は上の 4 段で、2 段目に `context` 文字列がそのまま含まれ、末尾が待機である。
- spawn argv に `--rules` が無い。
- spawn 経路に aiterm / tmux / `role=subagent` が無い。
- Grok 以外の `/tl` では `grok-continue` を呼ばない。

### 実機（t4 / t5）

- この Mac の Grok `/tl` から新席が立ち、session ディレクトリに載る。
- `grok --resume` 一覧にトップレベルとして見える。Desktop Inactive 畳みは成功条件にしない。
- その席の最初のモデル応答が前文の記憶を使う。宣言または L2 固有事実が出ること。
- `chat_history.jsonl` への後書きや hook stdout を成功に数えない。

## 円卓

工程正本は Lattice plan `grok-successor-launch`。実装は Throughline のみ。
