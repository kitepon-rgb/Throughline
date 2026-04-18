# 新 L1/L2/L3 設計（再定義）

> **Status**: 実装完了（2026-04-16 時点）。この文書は **L1/L2/L3 再定義の設計記録**であり、schema v4-v5 相当の変更までを扱う。以後の `handoff_batons` (v6)・`memo_text` (v7)・state.usage スナップショット・VSCode 自動起動・monitor 診断機能は本仕様と独立で、[CLAUDE.md](../CLAUDE.md) と [PUBLIC_RELEASE_PLAN.md](PUBLIC_RELEASE_PLAN.md) に索引あり。
> 全ステップ (1〜8) 実装済み。L1/L2/L3 すべて書き込みパスが稼働。schema v5 で details に `kind` / `source_id` 列追加済み。
> 進捗の詳細は「実装順序」セクション末尾の進捗表を参照。

## Context

現行実装は [docs/archive/CONCEPT.md](archive/CONCEPT.md) の原義から乖離しており、L1/L2 ともに段落先頭の機械的な切り詰めになっている。その結果：

- L1 の末尾（=結論）が常に失われ、文脈理解できない
- L1 と L2 が「同じ本文の別切り方」になっており質的階層になっていない
- L3 は SQLite にあるが `/sc-detail` 未実装で取り出せない「墓場」
- 完了済み ISSUE が L2 に溜まり続ける

ユーザーとの対話で、現行設計を捨てて新しい層定義を採用することに合意した。

## 新 L1/L2/L3 定義

3 層は **差分の関係**。L2 と L3 は補完関係にあり、重複しない。

| 層 | 役割 | 中身 | コンテキスト |
|---|---|---|---|
| **L1** 見出し | L2 を要約した 1 行索引 | Haiku 4.5 による要約（目標圧縮率 1/5） | 常駐（古いターンのみ、新しいターンは L2 があるので不要） |
| **L2** 本文 | 会話の自然言語部分 | ユーザー発言 + Claude のユーザー向け返答 | 常駐 |
| **L3** 裏方 | L2 に入れなかったもの | ツール入力、ツール出力、システムメッセージ、画像 | SQLite 退避、`/sc-detail <時刻>` でオンデマンド参照 |

### ノイズ除去ルール（全層共通）

以下は意味ゼロのノイズなので、L2 にも L3 にも保存しない：

- 空行・連続空白・インデント装飾だけの行
- 進捗表示（プログレスバー、パーセント、`████░░`）
- ANSI エスケープシーケンス
- 繰り返しの定型ヘッダ/フッタ（毎ターン同じ内容のリマインダ等）

### L2 に残すもの（明示）

- ユーザーが貼り付けた長大な生ログ（stacktrace、ビルドログ、JSON ダンプ等）
- Claude の返答に含まれるコードブロック
- TODO リスト構造化ブロック

これらは「会話の一部」として扱い、切り落とさない。

### L2 = L3 から何を引くか

L3（ノイズ除去後の全文）から以下を除いて L2 を作る：

1. ツールの入力（Bash コマンド、Read/Edit/Grep の引数）
2. ツールの出力（stdout/stderr、ファイル内容、検索結果）
3. システムメッセージ（フック注入、リマインダ、`<system-reminder>` 等）
4. 画像データ

これら 4 項目が L3 に入る。

**思考ブロック（extended thinking）は L2 にも L3 にも保存しない**。素の Claude Code のコンテキストでも思考ブロックはターン境界で削除されているため、比較対象と揃える意味で保存しない。signature 付きブロックの再注入問題も同時に解消。

### 比較の基準

新設計の評価は「`/clear` しなかった場合の素の Claude Code のコンテキスト」と比較する。引き算にしかならない設計なので、デフォルトより重くなる状況は原理的に存在しない。

---

## L1 生成方針

### モデル

**Haiku 4.5（`claude-haiku-4-5-20251001`）固定**。

### 呼び出し経路

**Claude Max 契約前提**。Anthropic API キーは使わず、`claude -p --model claude-haiku-4-5-20251001` を `child_process.spawn` で子プロセス起動する。認証は Claude Code CLI が管理している Max 契約の枠を使う。実機で 3 回成功を確認済み（Throughline ベンチマーク中）。

Windows 環境では `claude.cmd` ラッパー解決のため `shell: true` または `claude.cmd` を明示する。

### タイミング

**ターン終了時（Stop フック内）で同期実行**。完了を待ってから保存を確定する。

根拠：Claude 本体の返答時間（数十秒〜数分）に比べて、要約呼び出しの数秒は誤差。非同期化の実装複雑性を払う価値がない。

### 圧縮率

**目標 1/5**。Haiku 4.5 の実測ベンチマークに基づく。

実測結果（2 サンプル、原文 1,400〜1,850 文字）：

| 圧縮率 | 新聞記事（並列トピック 4 本） | 技術論文（直列論旨） |
|---|---|---|
| 1/5 | 論点・固有名詞・数値・因果すべて保持 | 同左 |
| 1/10 | ホルムズ海峡の話が消失（論点 1/4 脱落） | 1/5 とほぼ同品質 |
| 1/20 | 1 論点のみ残存、不合格 | 未測定 |

並列トピック耐性を考慮して **1/5 を下限・デフォルト** とする。コーディング会話は通常単一トピックなので 1/10 でも成立するが、Claude の長文返答が並列議論になるケースに備えて保守側を採る。

### 失敗時のポリシー

1. Haiku 呼び出しを **2 回リトライ**
2. それでも失敗したら **L2 の全文をそのまま L1 として保存**

理由：情報欠損ゼロ、データ構造に穴が空かない、後工程の分岐不要、後から再要約可能。

---

## スキーマ変更（schema v4）

```sql
-- skeletons: L1 = 1 行要約（意味変更、列は据え置き）
-- summary 列に Haiku 要約 or フォールバック時の L2 全文が入る

-- 新テーブル: bodies（L2 = 会話の自然言語本文）
CREATE TABLE bodies (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT NOT NULL,
  origin_session_id  TEXT NOT NULL,
  turn_number        INTEGER NOT NULL,
  role               TEXT NOT NULL,       -- user | assistant
  text               TEXT NOT NULL,
  token_count        INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, origin_session_id, turn_number, role)
);

-- details: L3 = ツール入出力・思考・システムメッセージ・画像
-- 現行の details テーブルを拡張し、tool_name 以外のカテゴリも受け入れる
-- もしくは kind 列を追加して区別する

-- judgments: 廃止。v4 で DROP
-- 理由: 素の Claude Code のコンテキストには「判断ラベル付き抽出リスト」は存在しない。
-- Throughline が勝手に作り出した余計な層であり、新設計の原則「比較対象は素の Claude、
-- そこからの引き算」に反する（引き算ではなく足し算）。
-- L2 ロスレスで 20 ターン保持しているので、制約・決定・未解決事項は会話本文内に自然な
-- 文として残る。素の Claude と同じく、会話本文を読めば十分。
```

---

## 生成パイプライン（Stop フック）

```
Stop フック受信
  ↓
transcript から当該ターンを取得
  ↓
ブロック分類（ノイズ除去を先に実行）
  ├→ ユーザー発言 / Claude 本文    → L2 (bodies) に INSERT
  └→ ツール I/O / 思考 / システム / 画像 → L3 (details) に INSERT
  ↓
Haiku 4.5 で L2 を約 1/5 に要約（同期、2 回リトライ）
  ├→ 成功 → skeletons に要約を INSERT
  └→ 失敗 → skeletons に L2 全文を INSERT（フォールバック）
```

---

## 注入パイプライン（SessionStart フック）

> **変更履歴**: 当初は UserPromptSubmit で毎ターン注入していたが、SessionStart と完全に重複するため廃止。注入は SessionStart の 1 回のみ。

注入対象は **前任チェーンの過去ターンのみ**。現セッション内のターンは Claude Code 本体のコンテキストに既に全文入っているので注入不要。

```
merge chain をたどり前任セッションのターンを時系列順に取得
  ↓
前任の直近 20 ターン → bodies から L2 全文を注入
前任のそれ以前のターン → skeletons から L1 要約のみ注入
  ↓
末尾に "/sc-detail <id> で退避データ復元可" のガイドを追記
```

### 注入テキストの新フォーマット

各行頭に **現セッション視点のローカル連番 ID**（`#1`, `#2`, ...）を付ける。Claude はこの ID をそのまま `/sc-detail` に渡せる。

```
## Throughline: セッション記憶

### 直近のターン履歴
[14:23:05] [user]: 〜〜
[14:23:05] [assistant]: 〜〜
...
[15:47:12] [assistant]: 〜〜

### それ以前の要約
[13:02:11] 要約1行...
[13:05:34] 要約1行...

---
過去ターンの詳細は `/sc-detail <時刻>` で取得可能（例: /sc-detail 14:23:05、/sc-detail 14:23-14:30）
```

### Claude に気づかせる仕組み

1. **注入テキスト末尾に案内文**（上記例の末尾行）
2. **各行頭の ID 表示**（Claude が自然に参照できる形で）

CLAUDE.md への記載は **しない**。配布時、新規プロジェクトで Throughline を導入したユーザーが手動で CLAUDE.md を編集する必要が出ると利便性の障害になる。注入テキスト自体で完結させる。

### `/sc-detail` コマンド仕様

- **ID は bodies テーブルの `created_at`（時刻ベース、DB 永続）を使う**
- 注入テキストの行頭に `[14:23:05]` の形式で時刻を表示
- `/sc-detail 14:23:05` → 指定時刻のターンの L2 + L3 をまとめて返す
- `/sc-detail 14:23-14:30` → 時刻範囲指定、複数ターンまとめて取得
- L2 と L3 を別コマンドに分けない（「このターンの詳細が欲しい」という Claude の意図に一発で答える）

### なぜ時刻ベースか

当初案の「ローカル連番 `#1, #2, ...`」は注入時に動的に採番されるだけで DB に保存されず、次ターンで連番がずれる問題があった。`created_at` は DB に永続保存されているので安定した ID になる。時刻は人間にも可読で範囲指定も自然。同一秒に複数ターンが終わる可能性はほぼ無い（Claude Code の 1 ターンには数秒以上かかる）。

**N=20 固定**。

根拠 1（原理）: 比較対象は「`/clear` せずに会話を続けた場合の素の Claude Code」であり、新設計はそこからツール入出力等を引き算したものなので、原理的にデフォルトより重くなる状況は存在しない。トークン予算制にする必要はない。

根拠 2（実測）: ユーザーの Claude Code 全トランスクリプト（`~/.claude/projects/` 配下、1,739 ファイル、Throughline プロジェクトは除外）から実作業セッション（3 ターン以上）86 件を抽出して分布を測った：

| 指標 | ターン数 |
|---|---|
| 中央値 (p50) | 13 |
| p25 | 5 |
| p75 | 34 |
| p90 | 71 |
| p95 | 108 |
| 最大 | 331 |

N=20 は中央値の約 1.5 倍、p75 の少し下。典型的なセッションは丸ごと L2 全文注入でき、長めのセッション（p75 以上）は超過分が L1 要約に格下げされる、という設計が自然に成立する。

---

## 影響ファイル

- [src/turn-processor.mjs](src/turn-processor.mjs) — Stop フック本体。ブロック分類 + Haiku 呼び出し + 3 テーブル書き込み
- [src/classifier.mjs](src/classifier.mjs) — **廃止**（judgments 廃止に伴い役割消滅）
- ~~src/context-injector.mjs~~ — **廃止**（SessionStart との重複注入解消。注入は SessionStart に一本化）
- [src/session-start.mjs](src/session-start.mjs) — 引き継ぎ注入を新構造に（注入の唯一のエントリポイント）
- [src/resume-context.mjs](src/resume-context.mjs) — レンダラ差し替え
- [src/db.mjs](src/db.mjs) — schema v4 migration、bodies テーブル追加
- [src/session-merger.mjs](src/session-merger.mjs) — **bodies テーブルも merge 追従対象に追加**、judgments 張り替えロジックは削除（skeletons/details/bodies の 3 テーブルで session_id 張り替え）
- [src/detail-capture.mjs](src/detail-capture.mjs) — **削除**（Stop フックに統合）
- [.claude-plugin/hooks.json](.claude-plugin/hooks.json) — detail-capture の PostToolUse 登録を削除
- [.claude/settings.json](.claude/settings.json) — classifier / detail-capture 関連 hook があれば削除
- [docs/CONCEPT.md](docs/CONCEPT.md) — 再定義の反映
- **新規**: `commands/sc-detail.md` — L3 オンデマンド参照コマンド。bodies 設計と同時実装必須

---

## 既存データの扱い

**新データのみ新構造**。v3 以前のセッションはマイグレーションしない。

- v3 データの skeletons/details はそのまま読み取り可能（judgments は読まない）
- v3 セッションを引き継いだ場合、bodies テーブルは空。L2 全文が無い状態
- SessionStart 注入は「bodies がなければ skeletons のみ注入」にフォールバック
- 二系統分岐の恒久化は避けたいので、v3 セッションは **read-only 扱い、書き込みは新構造のみ** と明示

---

## 追加で必須の作業

1. **`/sc-detail <turn>` コマンドの先行実装**  
   L3 退避先を読み出す手段がないと、参照マーカーがデッドリンクになる。本文ロスレス化と同時にリリースする必要あり

2. **session-merger の bodies 対応**  
   現行トランザクションから judgments の UPDATE 行を削除し、bodies の UPDATE 行を 1 行追加する。張り替え対象は skeletons/details/bodies の 3 テーブル + sessions.merged_into。既存の `BEGIN IMMEDIATE` ... `COMMIT` トランザクションに全部収める（途中失敗で中途半端な状態が残らないよう原子性を保証）

3. **judgments テーブルと classifier の廃止**  
   DB migration で judgments を DROP、classifier.mjs は削除。注入テキストから「未解決事項」セクションを除去

---

## 実装順序

依存関係に沿って以下の順で実装する。**judgments 参照の全削除を schema migration より先にやる** のがポイント（migration 後の中途半端な動作状態で crash するのを防ぐ）。

1. **judgments 参照の全削除**（先行クリーンアップ）
   - [src/turn-processor.mjs](src/turn-processor.mjs) から judgments 書き込みを削除
   - ~~src/context-injector.mjs~~ から judgments 読み出しを削除（ファイル自体が廃止済み）
   - [src/session-merger.mjs](src/session-merger.mjs) から judgments の UPDATE を削除
   - [src/classifier.mjs](src/classifier.mjs) 削除
   - [.claude/settings.json](.claude/settings.json) / [.claude-plugin/hooks.json](.claude-plugin/hooks.json) から classifier 関連 hook があれば削除
   - この段階では judgments テーブルは DB に残したまま。参照が消えただけ

2. **schema v4 migration** — [src/db.mjs](src/db.mjs)
   - bodies テーブル追加
   - judgments テーブル DROP（関連インデックスも DROP）
   - v3 データはマイグレーションせず read-only で共存
   - `user_version` を 4 に更新

3. **`/sc-detail` コマンド** — 新規 `commands/sc-detail.md` + ロジック実装
   - bodies と details を時刻指定で読み出す
   - 単一時刻と時刻範囲の両方サポート
   - 後段の動作確認に使えるので先に作る

4. **Stop フック改修** — [src/turn-processor.mjs](src/turn-processor.mjs)
   - transcript のブロック分類：
     - `type === 'text'` の user メッセージ → L2（ユーザー発言）
     - `type === 'text'` の assistant メッセージ → L2（Claude 本文）
     - `type === 'tool_use'` → L3（ツール入力）
     - user メッセージ内の `type === 'tool_result'` → L3（ツール出力）
     - `type === 'thinking'` → **破棄**（保存しない。素の Claude も削除しているため）
     - `type === 'image'` → L3（プレースホルダ化）
   - ノイズ除去（空白・進捗表示・ANSI・`<system-reminder>` タグ）
   - **実装着手時に transcript JSONL サンプル 1 件を実データで検証してから実装**
   - Haiku 4.5 同期呼び出しで L1 要約生成（2 回リトライ、失敗時は L2 全文を L1 に）
   - bodies/skeletons/details の 3 テーブルへ分離書き込み

5. **detail-capture.mjs 削除** — [src/detail-capture.mjs](src/detail-capture.mjs)
   - Stop フックに統合済みなので不要
   - [.claude-plugin/hooks.json](.claude-plugin/hooks.json) の PostToolUse 登録も同時に削除

6. **注入パイプライン改修** — [src/session-start.mjs](src/session-start.mjs)、[src/resume-context.mjs](src/resume-context.mjs)
   - 新フォーマット（`[HH:MM:SS]` 時刻プレフィックス）
   - 直近 20 ターンは bodies から L2 全文、それ以前は skeletons から L1 要約
   - 末尾に `/sc-detail` 案内文を追加
   - v3 セッションのフォールバック経路（bodies が空なら skeletons のみ）
   - ~~context-injector.mjs~~ は廃止（SessionStart に一本化）

7. **session-merger の bodies 対応** — [src/session-merger.mjs](src/session-merger.mjs)
   - BEGIN IMMEDIATE トランザクションに bodies の UPDATE を追加
   - 張り替え対象: skeletons / details / bodies / sessions.merged_into

8. **SessionStart 改修** — [src/session-start.mjs](src/session-start.mjs)
   - 引き継ぎ注入を新フォーマットで

9. **検証** — 各段階で smoke test を走らせ、ユーザーに動作確認してもらう

---

## 進捗（2026-04-16 時点）

| # | タスク | 状態 | 備考 |
|---|---|---|---|
| 1 | judgments 参照の全削除 | ✅ | |
| 2 | schema v4 migration (bodies 追加 / judgments DROP) | ✅ | |
| 3 | /sc-detail コマンド | ✅ | kind 別グループ化表示対応（tool / system / image / legacy） |
| 4 | **Stop フックのブロック分類 → bodies/skeletons/details 3 テーブル分離書き込み** | ✅ | schema v5 で details に `kind` / `source_id` 追加。`extractDetailBlocks()` で分類 |
| 5 | detail-capture.mjs 削除 | ✅ | |
| 6 | 注入パイプライン改修（新フォーマット） | ✅ | |
| 7 | session-merger の bodies 対応 | ✅ | |
| 8 | SessionStart 改修 | ✅ | |

### ステップ 4 の実装メモ

- **schema v5**: `details.kind TEXT NOT NULL DEFAULT 'tool_input'`, `details.source_id TEXT`。`UNIQUE(session_id, origin_session_id, source_id) WHERE source_id IS NOT NULL` で冪等再処理を保証
- **transcript-reader 拡張**:
  - `readRawEntries()` — 全エントリを生で返す（user/assistant だけでなく attachment/system も含む）
  - `sliceCurrentTurnEntries()` — 最後の user text から 最後の assistant text までを 1 論理ターンとして切り出す
  - `extractDetailBlocks()` — ブロック分類してレコード配列を返す
  - `stripAnsi()` / `normalizeToolResultContent()` — ノイズ除去ヘルパ
- **ブロック分類ルール（実装で確定）**:
  | 入力 | 出力 |
  |---|---|
  | assistant の `tool_use` | L3 kind=`tool_input`、source_id=`toolu_xxx`、input_text に JSON.stringify した input |
  | user の `tool_result` | L3 kind=`tool_output`、source_id=`toolu_xxx:result`、output_text (ANSI 剥離済み) |
  | attachment の `hook_success` | L3 kind=`system`、source_id=`attachment.uuid`、tool_name=`hook:<event>`、input_text=`command`、output_text=`content` |
  | `text` (user/assistant) | L2 bodies（L3 には入れない） |
  | `thinking` | 破棄（L2/L3 どちらにも入れない） |
  | `image` | L3 kind=`image`、プレースホルダ `[image]` |
  | `system` エントリ (`stop_hook_summary`) / `queue-operation` / `file-history-snapshot` | skip |
- **`<system-reminder>` タグ**: 実データ調査の結果、user text ブロックには **含まれない**（129 件すべて assistant の quote 内）。実体は attachment entry の hook_success として保存されるため、kind='system' として L3 に入る。したがって user text からの剥離は不要だった
- **実データ検証済み**: 現セッション (2292 entries) の最終ターンを slice すると 295 entries、そこから 20 tool_input + 20 tool_output + 173 system が抽出される

---

## 追加で発覚した課題（実装中に判明）

### turn_number ペアリングの食い違い（2026-04-16 修正済み）

bodies に user と assistant を別 turn_number で保存してしまい、「1 往復 = 2 ターン」として数えていた。修正で「1 往復 = 1 ターン（= assistant 側の turn_number）」に統一。

詳細: user と assistant を同じ turn_number でペアリングして bodies に書くよう [turn-processor.mjs](../src/turn-processor.mjs) を変更済み。

### 遅延 Haiku 要約（2026-04-16 追加）

20 ターン以内で終わる作業では Haiku 要約コストをゼロにするため、「21 ターン目以降、bodies ターン数が WINDOW(=20) を超えた時点で、最古の未要約ターンを 1 件要約する」という遅延方式に変更。

制約: 1 Stop につき最大 1 件しか要約しないので、merge で複数ターン一気に流入するとバックログが溜まる。現状は時間が経てば追いつく設計で放置。

---

## 検証方法

1. schema migration が v3 → v4 で壊れない（既存 DB で smoke test）
2. 新 Stop フックが bodies/skeletons/details に正しく分離書き込み
3. Haiku 同期呼び出しの平均レイテンシ計測（想定 2〜5 秒）
4. 要約失敗時のフォールバックが動作（Haiku 側を強制エラーにして確認）
5. SessionStart 注入が「直近は L2 全文、それ以前は L1 要約」で注入
6. `/clear` → SessionStart 引き継ぎが新構造で動く
7. `/sc-detail <turn>` で L3 が取れる
8. session-merger が bodies を正しく張り替える
9. 実セッションで 1 ターン 1/5 要約が品質を保っていることを確認（Haiku ベンチと同等）

---

## Haiku ベンチマーク実測記録（設計根拠）

対話の中で 2 サンプルを実機で Haiku 4.5 に投げた結果：

### サンプル 1: 新聞記事（約 1,850 文字）
- 内容: 米イラン再協議、対伊不和、ホルムズ海峡の 3 つの並列トピック
- **1/5**: 3 トピックすべて + 固有名詞 + 数値 20/5/10 年 + 因果関係保持。**合格**
- **1/10**: ホルムズ海峡が完全消失。3/4 トピックのみ。**ボーダー**
- **1/20**: 濃縮期間交渉のみ残存。**不合格**

### サンプル 2: 技術論文（約 1,430 文字）
- 内容: 光空間並列伝送 + MIMO 処理の研究
- **1/5**: 背景・手法・結果の 3 本柱すべて保持。**合格**
- **1/10**: 1/5 とほぼ同品質。**合格**

### 結論
- 単一トピック構造（論文・コーディング会話）: 1/10 でも OK
- 並列トピック構造（新聞・長文議論）: 1/5 が下限
- 保守的にデフォルト 1/5 を採用
