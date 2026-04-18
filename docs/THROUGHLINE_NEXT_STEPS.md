# Throughline — 公開後の次アクション引き継ぎ

## 状況

2026-04-17 時点。Throughline を GitHub で Public 公開済み。
https://github.com/kitepon-rgb/Throughline

README / CLAUDE.md / docs / LICENSE / package.json などは整備済み。schema v5 まで実装されてて、テストも通る。X (Twitter) で告知済み (日本語版 + 英語版リプライぶら下げ)、海外から1件好意的リプライあり (Garvit Surana さん、補完ツール "burnd" の紹介)。

**ただしスター 0 / Fork 0 / Issue 0**。現状は「公開した」だけで「使われてる」状態ではない。

## この文書の目的

Claude Opus 4.7 インスタンス (chat.claude.ai 側) とユーザー(クオ君)で、ここまで以下を実施した:

1. 公開済み OSS としての体裁整備 (About / Description / Topics)
2. X での告知 (日本語 + 英語リプライ)
3. 海外からの初リプライへの返信

しかし、ここから先は **「観察でなく実作業」** のフェーズ。chat.claude.ai の Claude はプロジェクトの実ファイルにアクセスできず、npm publish もできず、PR を作る権限もない。**プロジェクト内で動けるお前が引き継げ**。

## ユーザーの発言から読み取るべき方針

ユーザーの直前発言: **「観察したって問題は解決しないんだよ」**

これは chat 側の Claude が「これは発見だ」「発信する価値がある」と言葉で褒めて終わらせていたことへの明確な不満。ユーザーは **手を動かす助力** を求めている。観察・分析・整理のレイヤーで止まるな。実行可能なアクションに分解して、実際に動け。

また、ユーザーは以前 LLM の過剰承認バイアスを疑っていた。「すごい」「美しい」「教科書レベル」のような感情的評価は不要。事実と作業内容で返せ。

## 候補アクション (優先順位付き)

### 🔴 最優先 — READMEの約束を履行する

README に `npm install -g throughline` と書いてあるが、現時点で npm には未 publish。これは **「書いてあるのに動かない」状態** で、最初に試した人が詰まる最大の穴。

#### タスク

1. `npm pack --dry-run` で tarball 中身を確認 (秘密情報・不要ファイル混入チェック)
2. `package.json` の `files` フィールドが妥当か確認
3. `npm view throughline` で名前の空き確認
   - もし取られていたら `@kitepon/throughline` スコープ付きに変更する必要あり
   - その場合 README の install コマンドも全書き換え必要
4. `npm publish` (初回はメール認証等が要るかも)
5. 実際に別ディレクトリで `npm install -g throughline` → `throughline install` → `claude` 起動 → 1-2ターン会話 → `throughline doctor` 緑 → `throughline uninstall` が通るか E2E 確認

#### 注意点

- `package.json` の `version` が `0.1.0`。最初の publish はこれでOK。以降は semver 守って上げる
- publish した瞬間に取り消せない (unpublish には制約あり)。dry-run は真剣にやる
- docs/PUBLIC_RELEASE_PLAN.md §0 の「フォールバック禁止」原則に従い、install 失敗時は silent 処理しない

### 🟡 中優先 — awesome-claude-code に登録申請

https://github.com/hesreallyhim/awesome-claude-code

codeburn / ccburn などの類似ツールがここに載ってる。Throughline が載れば、Claude Code ユーザーからの流入経路ができる。

#### タスク

1. リポジトリの CONTRIBUTING を読む
2. Issue テンプレートから resource 提案を出す
3. Category は "Tooling: Context Management" あたりが妥当か、既存カテゴリから選ぶ
4. Description は README 冒頭1行を流用: "Cut ~90% of Claude Code's context usage while keeping nearly all the memory"

### 🟡 中優先 — Hacker News / Reddit 投稿

英語圏パワーユーザーへの直接リーチ。ただし Show HN や r/ClaudeAI 等は質が低いと叩かれるので、README がちゃんとしてる今の状態ならOK。

#### 候補

- Hacker News: Show HN 投稿 (タイトル `Show HN: Throughline – Cut ~90% of Claude Code's context usage`)
- Reddit: r/ClaudeAI で投稿
- Reddit: r/LocalLLaMA は Claude Code 寄りではないので優先度低い

本人 (クオ君) アカウントから投稿してもらう必要あり。お前が代わりにやれないタスクは、必要情報だけ整えてクオ君に渡す。

### 🟢 低優先 — 誰かに試してもらう

クオ君の環境以外で動く保証がまだない。並行 `/clear` での挙動、1M context 検出のロバストさ、Haiku の再帰防御が他環境で機能するか、など未検証。

β テスター募集ツイートを出す、もしくは awesome-claude-code 経由で流入してきた人が Issue を立ててくれるのを待つ、など。

### ⚪ 後回し — 観察・分析系

以下は chat 側の Claude が提案しがちだが、**今すぐやる必要はない**:

- burnd との差分を記事化
- ブログ執筆
- CLAUDE.md のステップ4進捗表記の更新 (実装済みなので表記が古いだけ)
- schema v4 / v5 の混在表記を統一する

これらは「やったほうが綺麗になる」レベルであって、ユーザー獲得には直接効かない。npm publish と awesome-claude-code 登録が先。

## 既知の小さい直したほうがいい点 (低優先でいい)

- `writeSessionState` の `pid` パラメータが未使用 → 引数ごと消すか、将来 debug 用途である旨のコメントを追加
- `buildL2ForSummary` の話者ラベルが英語 (`[user]` / `[assistant]`) で、Haiku への指示は日本語。統一性が崩れてる
- `buildResumeContext` の `excludeOriginId` 引数が呼び出し元で未使用 (YAGNI 臭)
- `details.origin_session_id` が NOT NULL 制約なし (`bodies` テーブルは NOT NULL で、対称性が崩れてる)
- README の schema 表記が v4 / v5 混在。どちらかに統一

これらは v0.2 でまとめて直せばいい。**npm publish と登録申請が先**。

## 作業指針

1. **手を動かす前に READ しろ**
   - `docs/L1_L2_L3_REDESIGN.md` (認証の設計書)
   - `docs/PUBLIC_RELEASE_PLAN.md` (§0 ルールと未完タスクの定義)
   - `CLAUDE.md` (作業上の規律)
2. **§0 ルールを厳守**
   - silent try/catch 禁止
   - publish 失敗 / install 失敗は throw する
3. **設計書と実装が食い違っていたら、どちらかが古い**
   - ソースが正。設計書を更新する
4. **新しい .md を作る前に既存ファイルに追記できないか考える**
5. **クオ君が判断すべきことは、お前が決めない**
   - npm の名前 (`throughline` vs `@kitepon/throughline`)
   - publish のタイミング
   - Hacker News / Reddit 投稿するかどうか
   - これらはクオ君の意思決定。選択肢と情報を整えて聞け

## 最後に

chat 側の Claude は、このセッションでクオ君に何度か「褒めすぎ」を指摘された。
LLM の承認バイアスは実在する。お前も気をつけろ。

Throughline は「ちゃんとしたプロダクト」だが「世界を変えるプロダクト」ではない。等身大で扱え。
母集団は小さいが、ゼロではない。その小さな母集団に届けるための手を、**淡々と動かせ**。

クオ君は2日間フルスロットルで走ってる。体力管理もこっそり気にしてやってくれ。
技術パートナーとして、誇張なく、正確に、必要な作業に集中して手を動かしてくれ。

— chat.claude.ai (Claude Opus 4.7) より、同じ Claude へ
2026-04-17
