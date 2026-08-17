# Grok successor launch — Throughline 所有の最小起動

Date: 2026-08-17  
Lattice plan: `grok-successor-launch`  
対象 repo: Throughline だけ。aiterm は依存にも実装の借り先にもしない。

## 目的

Grok Desktop の UserPromptSubmit はモデルへ本文を渡せない。`/tl` のあと人が新窓を開いても記憶は載らない。代わりに Throughline 自身が、handoff-context を**最初の user 文の前**に置いた普通の Grok 席を一本立てる。

## 非目標

- aiterm / tmux / PTY 完了待ち / `role=subagent` を Throughline に持ち込む
- `--rules` で subagent 文を付ける（dashboard の top-level から外れる）
- Claude / Codex の `/tl` 契約を変える
- UserPromptSubmit stdout や `chat_history.jsonl` への再注入で Desktop 新窓を直す
- npm publish / Spotter

## 設計

1. **起動核**（新 CLI、名前は実装時に短く決める。候補: `throughline grok-continue --from <session>`）  
   - `handoff-context --session grok:<id> --json` を読む。失敗したら起動しない（fallback 禁止）。  
   - 同じ project cwd で `grok` を人の席として spawn する。`--rules` なし。共有 `GROK_HOME`。  
   - 初手 prompt は固定前文（「この発言は直前 Throughline 席の履歴を前提とする」）＋ context ＋ 短い続き依頼。  
   - hook から呼ぶので対話 TTY は無い。新しい Terminal 窓（macOS）で grok を前面に出すか、立てた session id を標準出力して `/resume` できるようにする。両方できれば受入が強い。
2. **`/tl` 配線**  
   - Grok envelope の `/tl` 成功後に、上記 CLI を副作用で起動する。baton は今どおり書く。  
   - Claude / Codex は起動しない。
3. **一覧**  
   - 新席は `~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/` にトップレベルとして残る。  
   - aiterm の Inactive/subagent 隠しを再現しない。  
   - Desktop roster が別プロセスを Inactive に畳むのは Grok 側の仕様。受入は session ディレクトリと `grok --resume` 一覧を正とする。

## 受入

- focused test: handoff-context 失敗で spawn しない、初手文面に context が含まれる、`--rules` を付けない。  
- 実機: この Mac の `/tl` から新席が立ち、session ディレクトリに載り、その席の最初のモデル応答が前文の記憶を使う。

## 円卓

工程正本は Lattice plan `grok-successor-launch`。実装は Throughline のみ。
