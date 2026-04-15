# Throughline 実験シート

このファイルは「session_id と `/clear` の挙動」について、推論ではなく**生データだけ**から事実を確定するための記録用紙です。

**ルール:**
- 私（Claude）の口頭での結論は信用しない
- すべての命題は「誰でも追跡できる生データの参照」で裏付ける
- 結果は「確定 / 反証 / 未検証」の 3 状態のみ
- 曖昧な場合は未検証のまま

---

> **実装設計**: 命題 X の具体的な実装設計と実験プロトコルは [SESSION_LINKING_DESIGN.md](SESSION_LINKING_DESIGN.md) を参照。

## 最終目標（Goal）

**旧 session_id と新 session_id を `/clear` を跨いで 1 対 1 で紐づける。**

紐づけができれば：
- 記憶は `/clear` を跨いで連鎖する（A → A2 → A3 …）
- 並行して走る別作業（セッション B）の記憶は混ざらない
- project_path + 時間窓のような曖昧推測は不要

この目標に対する現行の課題：`/clear` 直後の UserPromptSubmit には新 session_id だけが届き、旧 session_id は含まれていない。旧と新を繋ぐ「糊」がどこにあるのかが不明。

---

## 命題一覧

### 命題 A: `/clear` を実行すると session_id は変わる

- **状態**: 未検証
- **検証方法**:
  1. 現在の session_id を記録
  2. ユーザーが `/clear` を実行
  3. `/clear` 後に何かメッセージを送信
  4. 新しいメッセージの UserPromptSubmit ログに記録された session_id を読む
  5. 変化していれば確定、同じなら反証
- **必要なログ**: `~/.throughline/spike/hooks.log`（UserPromptSubmit を含む全イベント）
- **生データ参照**:
  - Before: hooks.log 9493 行、`2026-04-15T05:51:38.277Z`、session_id = `a2335bc7-c354-4172-ab89-abff7c7b6ee6`、prompt = `"確認"`
  - After: hooks.log 9656 行、`2026-04-15T05:53:34.961Z`、session_id = `42065160-337c-40c7-8066-2807aa312270`、prompt = 実験続きプロンプト
- **結果**: **確定**（a2335bc7 → 42065160 に変化）

---

### 命題 B: Stop フックは `/clear` の直前に必ず発火する

- **状態**: **反証**（`/clear` そのものでは Stop が発火しない）
- **検証方法**:
  1. `/clear` 実行直前の session_id を記録
  2. `/clear` 実行
  3. hooks.log を読み、最後の Stop エントリのタイムスタンプと session_id が「`/clear` 直前の session_id」と一致し、タイムスタンプが `/clear` 直前であるか確認
- **生データ参照**:
  - `/clear` 直前の session_id: `a2335bc7-c354-4172-ab89-abff7c7b6ee6`
  - `/clear` 前の最後の Stop エントリ: hooks.log 9614 行、`2026-04-15T05:52:47.751Z`、session_id = `a2335bc7...`（`last_assistant_message` = 「以下を `/clear` 後にそのまま貼ってください…」= 応答完了時の Stop）
  - `/clear` 前の最後の UserPromptSubmit: hooks.log 9574 行、`2026-04-15T05:52:29.516Z`、prompt = 「clear 後に君は記憶を失うかもしれない…コピペ案をください」
  - `/clear` 後の最初の UserPromptSubmit: hooks.log 9656 行、`2026-04-15T05:53:34.961Z`、新 session_id = `42065160...`
  - **9614（Stop, 05:52:47）と 9656（UserPromptSubmit, 05:53:34）の間に Stop エントリは存在しない**
- **結果**: 反証。`/clear` 操作そのものでは Stop フックは発火していない。9614 の Stop は「コピペ案をください」への応答完了時の Stop であり、`/clear` トリガーではない。

---

### 命題 C: Stop フックの stdin には「そのセッションの」session_id が含まれる

- **状態**: **確定**
- **検証方法**: 命題 B の Stop エントリの `stdin.session_id` を確認
- **生データ参照**: hooks.log 9614 行の Stop エントリ、`stdin.parsed.session_id = "a2335bc7-c354-4172-ab89-abff7c7b6ee6"`（`/clear` 前のセッションと一致）
- **結果**: 確定（Stop の stdin には発火したセッションの session_id が含まれる）

---

### 命題 D: `/clear` 後の最初の UserPromptSubmit で新 session_id が届く

- **状態**: **確定**
- **検証方法**: 命題 A と同じデータで判定
- **生データ参照**: hooks.log 9656 行、session_id = `42065160-337c-40c7-8066-2807aa312270`（`/clear` 前の a2335bc7 と異なる新 ID）
- **結果**: 確定

---

### 命題 G: Stop フックが発火するタイミングは何か？

- **状態**: **確定** — (c) アシスタントが応答を返し終えるたびに発火する
- **過去に私が言った候補:**
  - (a)「Stop は `/clear` の直前に発火する」 → **反証**（命題 B 参照）
  - (b)「Stop はセッション終了時に発火する」 → **反証**（1 セッションで複数回発火している）
  - (c)「Stop はアシスタントが応答を返し終えるたびに発火する」 → **確定**
- **生データ参照**:
  - hooks.log 9493 UserPromptSubmit「確認」→ 9532 Stop（`last_assistant_message` = 「前提整いました。生データ：…」）
  - hooks.log 9574 UserPromptSubmit「コピペ案をください」→ 9614 Stop（`last_assistant_message` = 「以下を /clear 後にそのまま…」）
  - UserPromptSubmit と Stop が 1 対 1 で対応
  - Stop の stdin には `last_assistant_message` フィールドがあり、直前に完了したアシスタント応答の全文が入っている
- **結果**: 確定（1 ターン分のアシスタント応答が完全に終わったタイミングで発火）

---

### 命題 E: SessionStart フックは `/clear` 時に発火しない

- **状態**: **反証**
- **生データ参照**:
  - session-start.log 4 件目: `2026-04-15T05:53:31.674Z`、session_id = `42065160-337c-40c7-8066-2807aa312270`、`source: "startup"`
  - この 42065160 は `/clear`（05:52:47 の Stop のあと、05:53:34 の UserPromptSubmit より前）で発生した新セッション
  - つまり `/clear` 後にも SessionStart が発火している（ただし source は `"startup"`）
- **結果**: 反証。`/clear` 後も SessionStart は発火する。VSCode 拡張では /clear が内部的に新プロセス扱いになっている可能性。

---

### 命題 F: SessionStart フックの source 値として現時点で観測されたのは "startup" のみ

- **状態**: 確定
- **生データ参照**: `~/.throughline/spike/session-start.log` 4 件すべて `source: "startup"`（75a05214, 977cfe3a, a2335bc7, 42065160）
- **結果**: 確定。`/clear` 後の新セッションでも `source` は `"startup"`。`"clear"` / `"resume"` は未観測。

---

### 命題 H: SessionStart フックは新セッションの最初の UserPromptSubmit より前に発火する

- **状態**: **確定**
- **生データ参照**:
  - session-start.log 4 件目: `2026-04-15T05:53:31.674Z`、session_id = `42065160...`
  - hooks.log 9656 行、最初の UserPromptSubmit: `2026-04-15T05:53:34.961Z`、session_id = `42065160...`
  - 差分: SessionStart が UserPromptSubmit の **約 3 秒前**に発火
- **結果**: 確定。ユーザー発言を待たずに新 session_id を取得できる。

---

## 核心命題: 旧 → 新 session_id の紐づけ

### 命題 X: Stop フックが旧 session_id をファイルに書き、次の SessionStart or UserPromptSubmit がそれを読めば、旧 → 新の紐づけが成立する

- **状態**: **前提条件すべて確定。実装可能。**
- **前提条件（更新版）:**
  - ~~命題 B: Stop が `/clear` 直前に必ず発火する~~ → 反証。ただし命題 G で代替：**毎ターン末尾で Stop が発火するので、常に最新の旧 session_id がファイルに上書きされ続ける**。`/clear` 直前の Stop は「直前のアシスタント応答完了時の Stop」で十分。
  - 命題 C: Stop の stdin に旧 session_id が含まれる ✅ 確定
  - 命題 D: `/clear` 後の最初の UserPromptSubmit で新 session_id が届く ✅ 確定
  - 命題 G: Stop は応答完了ごとに発火 ✅ 確定
  - 命題 H: SessionStart は UserPromptSubmit より前に発火し、新 session_id が届く ✅ 確定（UserPromptSubmit より 3 秒早い）
- **実装案（改訂）:**
  1. Stop フック: `~/.throughline/last-session-by-project/<project_hash>` に旧 session_id を書き込む（毎ターン上書き）
  2. SessionStart フック: 新 session_id を受け取ったとき、上記ファイルを読んで旧 session_id を取得 → DB で記憶を新 session_id に移管（UserPromptSubmit より前に完了するので再注入に間に合う）
- **既知の課題（サブ命題 X-1）:** 並行セッション B が同一 project_path で動いている場合、B の Stop がファイルを上書きして A の紐づけを破壊する（未解決）

#### 命題 X の実測検証 #1（2026-04-15 07:07〜07:08）

- **状態**: **反証**（10 秒窓の設定では紐づけ不成立）
- **実装**: `spike/session-link-writer.mjs`（Stop）, `spike/session-link-reader.mjs`（SessionStart）, 窓 = 10000ms
- **手順**: /clear 直前の最終応答 Stop でファイル書き込み → /clear 実行 → 新セッションで SessionStart が読む
- **生データ参照**:
  - project_hash: `c86cce038550be3b`（ドキュメント記載の `b0b9520facad6366` は誤り）
  - state file (`~/.throughline/session-link/c86cce038550be3b.json`):
    ```json
    {"old_session_id":"42065160-337c-40c7-8066-2807aa312270","ts":1776236862765,"state":"open"}
    ```
  - link.log 末尾:
    - (a) `2026-04-15T07:07:42.766Z` op=write, old_session_id=`42065160-337c-40c7-8066-2807aa312270`（/clear 直前の Stop）
    - (b) `2026-04-15T07:08:02.952Z` op=**read-miss-stale**, new=`34cf32a9-cc54-4710-a799-135e818176d0`, source=startup, **elapsed_ms=20187**, old_session_id=42065160...
    - link-success エントリ **無し**、state-closed エントリ **無し**
  - session-start.log 5 件目: `2026-04-15T07:08:02.933Z`, session_id=`34cf32a9-cc54-4710-a799-135e818176d0`, source=startup
  - SessionStart（07:08:02.933Z）→ reader 処理（07:08:02.952Z）の順序は確定（差 19ms）
- **判定:**
  - ❌ state="open" のまま（closed になっていない）
  - ❌ link-success が記録されていない
  - ❌ elapsed_ms=20187 > 10000ms 窓（stale 判定）
  - ✅ old=42065160 / new=34cf32a9 は期待どおり
  - ✅ 書き込み → SessionStart → 読み取りの順序は正しく動作
- **失敗原因の生データ**: Stop (07:07:42.766Z) と SessionStart (07:08:02.933Z) の間隔 = 20.167 秒。10 秒窓では収まらない。
- **次の判断材料**: 窓を 60 秒または 300 秒に拡張して再試行するか、窓そのものを廃止して「紐づけ完了後のみ close」方式で運用するか要検討。cwd の大小文字違い（write="C:\\..." vs read="c:\\..."）も観測されたが、ハッシュは一致しておりこの要因では失敗していない。

#### 命題 X の次アプローチ計画

10 秒窓を拡大する以外に、根本的に別ルートがないかを調べる。優先度順:

- **アプローチ 1: `/clear` 操作に関連して発火し、旧 session_id を取得できる hook/メカニズムが他に存在しないか調査**
  - 既知の hook: PostToolUse, Stop, PreCompact, UserPromptSubmit, SessionStart
  - 未確認: SessionEnd, Notification, その他ドキュメント化されていない hook
  - `/clear` に対応する専用 hook（`OnClear` 的なもの）の有無
  - PreCompact hook が `/clear` でも発火するか（manual trigger の挙動）
  - SessionStart の stdin に旧 session_id が含まれる隠しフィールドの有無
  - **検証方法**: 公式ドキュメント調査 + spike/hook-logger.mjs で全 hook を記録しながら `/clear` を実行、差分観測

- **アプローチ 2: スキル/hook から UI セッションを操作する手段の調査**
  - スキルや hook の中から Claude Code の UI アクション（`/clear`、新セッション起動）を発動する API の有無
  - Bash から `claude` CLI を起動した場合の挙動（独立プロセスになるか、UI 置換できるか）
  - VSCode 拡張のコマンドパレット項目を外部から叩く手段の有無
  - **検証方法**: 公式ドキュメント調査 + claude-code-guide エージェント経由での確認

現在アプローチ 1 を実行中。

##### アプローチ 1 調査ログ（2026-04-15）

###### ドキュメント調査結果（未検証・公式ドキュメント記載ベース）

claude-code-guide エージェント経由で [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) を参照した結果:

- **公式 hook 全 12 種**: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, SessionEnd
- **`/clear` 専用 hook は存在しない**
- **SessionStart の source 値は 4 種**: `startup` / `resume` / `clear` / `compact`（ドキュメント上）
- **SessionEnd hook が存在**: stdin に `session_id`, `transcript_path`, `reason` を含む。ただしドキュメントは「`/clear` では発火しない」と主張
- **PreCompact は `/clear` では発火しない**（ドキュメント主張）
- **SessionStart stdin の前セッション ID 隠しフィールドは記載なし**

###### ドキュメントと命題 F の矛盾点

| 項目 | ドキュメント | 命題 F（実機 5 件） |
|---|---|---|
| SessionStart の source | "clear" が存在 | 全て "startup" |

この食い違いは以下のいずれかで説明される（未確定）:
- (a) Windows + VSCode 拡張環境ではドキュメントと挙動が異なる
- (b) ドキュメントが一部誤記または未実装機能を記載している
- (c) 特定バージョンからの新機能で、手元環境が未対応

###### 実機検証プロトコル（次に実行）

1. `.claude/settings.json` に spike/hook-logger.mjs を以下の hook 全てに登録 ✅ 済
   - SessionEnd, StopFailure, SubagentStart, SubagentStop, PostToolUseFailure, PermissionRequest, PreCompact, Notification
2. ユーザーが `/clear` を実行（現セッション終了）
3. 新セッションで任意のメッセージ送信
4. hooks.log と session-start.log の差分から以下を観測:
   - (i) SessionEnd が発火したか（`/clear` のタイミングで）
   - (ii) SessionEnd stdin に旧 session_id が含まれるか
   - (iii) SessionStart の source が "clear" に変わるか
   - (iv) SessionStart stdin に隠しフィールド（previous_session_id 等）があるか
   - (v) PreCompact, Notification など他の hook が発火するか
5. 結果を命題 F・命題 E の再検証として記録
6. SessionEnd が /clear で発火 + 旧 session_id 取得可能なら、**命題 X の時間窓問題は解決**（SessionEnd → SessionStart の間隔は Claude Code 内部処理のみで、ユーザー操作時間を含まない）

###### /clear 実行前の記録（Before）

- 現セッション session_id: `34cf32a9-cc54-4710-a799-135e818176d0`
- hooks.log 行数: 11047（これ以降が After 差分）
- session-start.log 行数: 180
- session-link/link.log 行数: 15
- state ファイル: `c86cce038550be3b.json`, state="open", old=42065160（古い、次の Stop で 34cf32a9 に上書きされる想定）

###### 実機検証結果（2026-04-15 07:44〜07:46）

- **状態**: アプローチ 1 **反証**（/clear で追加 hook は 1 つも発火せず）
- **新 session_id**: `0129aeb8-b83d-44fe-9d4f-46a8d1adbb02`

**After 差分で発火した hook 集計**（`hooks.log` 11048 行目以降、`grep -oE '"hook_event_name": "[^"]*"' | uniq -c`）:

| hook | 発火回数 |
|---|---|
| Stop | 3 |
| UserPromptSubmit | 3 |
| PermissionRequest | 7 |
| SessionEnd | **0** |
| PreCompact | **0** |
| Notification | **0** |
| StopFailure | **0** |
| SubagentStart | **0** |
| SubagentStop | **0** |
| PostToolUseFailure | **0** |

（SessionStart は hooks.log ではなく session-start.log に記録される別経路。1 件発火）

**個別観測:**

- (a) **SessionEnd: 未発火**。`.claude/settings.json` には `{ "SessionEnd": [{ "command": "node spike/hook-logger.mjs SessionEnd" }] }` を登録済み。PermissionRequest が 7 回正しく発火していることから、追加 hook 登録そのものは有効。にもかかわらず /clear 経路で SessionEnd は一度も呼ばれなかった。
- (b) **SessionStart の source**: `"startup"` のまま（session-start.log 181 行目、`parsed.source = "startup"`、新 session_id `0129aeb8-b83d-44fe-9d4f-46a8d1adbb02`）。命題 F 再確認。
- (c) **SessionStart stdin の隠しフィールド**: **無し**。parsed キーは `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source` の 5 つのみ。`previous_session_id` / `parent_session_id` / `resumed_from` 類のフィールドは存在しない。
- (d) **PreCompact / Notification / SubagentStart/Stop / StopFailure / PostToolUseFailure**: 全て発火回数 0。
- (e) **PermissionRequest は発火した**（7 回、全て Bash tool の許可要求）— これは登録が有効であることの動作証明になる。

**link.log 観測:**

```
2026-04-15T07:44:34.928Z op=write  old=34cf32a9... (旧セッションの /clear 直前 Stop)
2026-04-15T07:45:05.233Z op=read-miss-stale new=0129aeb8... source=startup elapsed_ms=30305 old=34cf32a9...
2026-04-15T07:45:16.445Z op=write  old=0129aeb8... (新セッション最初の Stop)
2026-04-15T07:46:02.901Z op=write  old=34cf32a9... (**並行セッションからの Stop**)
```

- **elapsed_ms = 30305** > 10000ms → stale。命題 X 実測 #1（20.167 秒）より更に長くなった。
- link-success / state-closed のエントリは依然として無し。

**命題 X-1（並行セッション問題）の実機発現:**

`07:46:02.901Z` の write は、現セッション `0129aeb8` が動作中であるにも拘らず旧セッション `34cf32a9` から発火している。これは hooks.log でも確認できる:
- 11183 行: `UserPromptSubmit` session_id=`34cf32a9`, prompt="次のセッションのClaudeが何やったらいいかわかんないみたい…"
- 11223 行: `Stop` session_id=`34cf32a9`, last_assistant_message="以下を `/clear` 後にそのまま貼ってください…"

つまり、ユーザーは `/clear` して `0129aeb8` を開いた後も、旧セッション `34cf32a9` の別ウィンドウを生かして追加の指示を出していた。旧セッションの Stop が state ファイルを上書きし、現セッション (`0129aeb8`) の視点からは「自分でない session_id が state に書かれている」状況になっている（state.json は old=`34cf32a9`, 現在は `0129aeb8`）。命題 X-1 の破綻シナリオが机上ではなく実機で起きた。

###### 判定

| 観測項目 | 結果 |
|---|---|
| SessionEnd が /clear で発火 → 時間窓問題解決 | ❌ 発火せず |
| SessionStart source が "clear" | ❌ "startup" のまま |
| SessionStart stdin に隠しフィールド | ❌ 無し |
| 他の追加 hook（PreCompact 等）で旧 session_id 取得 | ❌ 全て発火せず |

**アプローチ 1 は「追加 hook ルートなし」で確定（反証）。** Windows + VSCode 拡張環境では、ドキュメント記載の SessionEnd（`reason: "clear"`）, SessionStart source `"clear"`, PreCompact 等はいずれも実機で確認できなかった。

**次の方針候補:**

1. **アプローチ 2 に移行**: スキル/hook から UI セッション操作を試みる路線の調査
2. **時間窓の大幅拡張 + X-1 対策**: 窓を 300 秒以上に拡張した上で、並行セッション衝突を transcript_path などで弁別するキー設計に変更
3. **窓廃止 + 使い捨てファイル方式**: Stop が書くファイル名に session_id を含め、SessionStart 時点では「最新の変更時刻を持つ *自分でない* session_id のファイル」を選ぶ方式。ただし並行セッション B の影響は残る


---

### 命題 X-1: 並行セッション問題 — 同一 project_path で複数セッションが並行するとファイル方式は破綻するか

- **状態**: 論理的に確定（未実装のため机上）
- **破綻シナリオ:**
  1. セッション A が作業中、session_id = A
  2. セッション B を別ウィンドウで開始、session_id = B
  3. A が応答 → Stop 発火 → ファイルに A を書き込む
  4. B がユーザー発言 → UserPromptSubmit → ファイルから A を読む → **B を A の継続と誤認**
- **回避案（未検証）:**
  - (a) project_path + transcript_path で一意化する
  - (b) Stop が書くファイルのキーを「親プロセス PID」などセッション固有の値にする
  - (c) Claude Code 起動時のウィンドウ ID / ターミナル TTY を使う
  - (d) 諦める（ユーザーに「並行セッションは非推奨」と明示する）
- **結果**: 未検証

---

## 次にやること（優先順）

1. **命題 A・B・C・D・G を 1 回の `/clear` 操作で同時に検証する**
   - 手順：
     1. 現在の session_id を記録
     2. hooks.log の Stop エントリ数を記録（before）
     3. ユーザーが `/clear` を実行
     4. ユーザーが任意のメッセージを送信（例: 「確認」）
     5. hooks.log を読み、差分から以下を埋める:
        - `/clear` 直前の最後の Stop エントリ（命題 B・C）
        - `/clear` 後の最初の UserPromptSubmit エントリ（命題 A・D）
     6. 命題 G は既存ログだけで判定可能（Stop 発火回数 vs ターン数 vs セッション数）
2. 結果をこのファイルに書き込む
3. 命題 X の実装可能性を判定
4. 命題 X-1（並行セッション問題）の回避案を検討

---

## ppid 実機検証（2026-04-15）

### 仮説
同一 Claude Code プロセスから生まれたセッションは hook の `process.ppid` が共通のはず。`/clear` 跨ぎで同 ppid を見て前任セッションを紐づけられないか。

### 生データ（hooks.log 12104 行目以降）

| 時刻 | hook | session_id | pid | ppid |
|---|---|---|---|---|
| 07:57:37 | Stop | `0129aeb8` (旧) | 70008 | **29456** |
| 07:57:54 | UserPromptSubmit | `f67ce28b` (新) | 33356 | **75600** |
| 07:58:04 | PermissionRequest | `f67ce28b` (新) | 60908 | **132140** |

並行セッション `34cf32a9` の hook 発火はこの窓内に **無し**（grep 該当は引用文字列のみ）。

### Windows プロセス照会
`powershell Get-CimInstance Win32_Process -Filter "ProcessId=<N>"` を 29456 / 75600 / 132140 / 70008 / 33356 / 60908 全てに実行 → **全て結果空（既に消滅）**。hook プロセスは短命で、WMI 照会時点でプロセスツリーから消えている。親プロセス名確認不能。

### 判定
- **ppid 仮説は不成立**。
- 決定的事実: **同一セッション `f67ce28b` 内の 2 つの hook 呼び出しで ppid が異なる**（75600 vs 132140）。セッション単位でも ppid は安定していないので、「同 ppid = 同 Claude Code プロセス = 前任紐付け候補」という前提が成立しない。
- `/clear` 跨ぎ（29456 → 75600）も当然不一致。
- hook は毎回 `node spike/hook-logger.mjs` を新規 spawn しており、その親プロセス（おそらく cmd.exe や Claude Code の中間 spawner）も呼び出しごとに使い捨てされている可能性が高い。Claude Code 本体プロセスまで辿るには ppid を連鎖的に parent‑walk する必要があるが、そのどこかの世代が hook 実行終了後に即死するため WMI で追跡不能。
- 並行 34cf32a9 のデータは取れなかった（差分窓で発火なし）。X-1 への効果は今回の実験では判定材料なし。

### 含意
- process.ppid は Windows + VSCode 拡張環境では **セッション相関キーとして使えない**。
- 追加調査の価値があるとすれば「ppid を parent-walk して Claude Code 本体 PID まで辿り、その PID をキャッシュする」方式だが、中間世代の寿命問題でブラックボックス化しており筋が悪い。
- アプローチ 1（hook 側で /clear を観測・相関）は ppid でも救えず、これで追加ルート全滅。

