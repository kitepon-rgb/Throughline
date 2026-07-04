# Throughline transcript injection 計画書 (v0.5 系)

このドキュメントは、SessionStart hook stdout 注入の根本欠陥を解消するための新フェーズ計画。
TODO を兼ねる。各タスクのチェックボックスを進捗管理に使う。

---

## 0. 解決したい問題

**現象**: `/clear` 直後の新セッションで、Throughline は 18KB の濃密な記憶 (L1+L2+L3) を SessionStart hook stdout に書き込んでいる。merge も注入も DB 上は完全に成立している (`~/.throughline/logs/inheritance-decision.log` で `merged=true` 実測)。それでも Claude は「続きよろしく」のような短い prompt を **新規挨拶として扱い**、「何が？」と返してくる。

**ユーザーの実体験** (注入された L2 にも記録されている過去 2 回の訴え):
- `21:51:46 [user]: Through line で引き継いでないの？`
- `22:12:58 [user]: だから記憶引き継いでるだろ。`

**直近 OpenCClaw クリアセッション `e48a7390` の実測**:
- L1: 15 件 / L2: 68 件 / L3: 2457 件 が merge 済み
- `buildResumeContext` 出力 18,658 文字、現在地アンカー + L1 要約 + L2 全文を含む
- それでもユーザー体感は「引き継いでいない」

---

## 1. 根拠 (4 並列調査の収束)

参考: 2026-05-23 のマルチエージェント調査結果。

### 1.1 Claude が「会話の続き」と認識する条件

Anthropic Messages API 公式 docs ([Working with Messages](https://platform.claude.com/docs/en/build-with-claude/working-with-messages)):

> Earlier conversational turns don't necessarily need to actually originate from Claude. **You can use synthetic `assistant` messages.**

要点: **`user` / `assistant` の交互 role turn** が「会話履歴」として LLM に認識される唯一の正式インターフェース。`system` / `system-reminder` に長文を埋めるのは「指示・参考資料」扱いで、会話継続トリガーにならない。

### 1.2 SessionStart hook stdout の届き方 (実 attachment で実測)

実 transcript JSONL の attachment 実測 (`~/.claude/projects/-home-kite-projects-OpenCClaw/e48a7390-7b88-46a2-bc26-73e9ecee4a2a.jsonl` line 1) で確認した事実:

- 現行 Throughline は stdout に **19,083 文字** の生 text を書いている (`/clear` 直後の SessionStart:clear hook)
- これは `attachment.type = "hook_success"` の `stdout` フィールドに **完全保存** されている (preview 置換 / 切り詰めなし)
- **「10,000 文字上限」のような制約は実態にない** (line 25 の別 hook では 34 KB の stdout も保持されている)
- 「指示・参考情報」として system 側に届く = role 無し
- 構造化 JSON 出力 (`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`) を返すと `hook_additional_context` attachment が別途生成されるが、生 text 出力でも transcript 上は完全に保持される

**したがって本計画 v0.5 では**: stdout 経路は **現行を完全維持** (ヘッダ + 現在地アンカー + L1 + L2 verbatim + L3 ref の生 text、サイズキャップなし)。L2 verbatim を transcript JSONL に role 付きで **追加** で append する (二重出力を許容)。

これは v0.5 の本質が「**role の不在を解消する**」ことであって「**サイズ最適化**」や「**出力形式の刷新**」ではないため。

**二重出力を許容する理由**: transcript JSONL append が何らかの理由で Claude に届かない環境 (Claude Code minor update での format 変更、Cursor 等の Claude Code 互換層、サードパーティ wrapper) でも、現行 v0.4.12 と同等以上の体験を保証する。`docs/04_public_release_plan.md` §0 の「フォールバック禁止」は「エラー隠蔽 / silent fallback」を禁ずるもので、**情報を 2 経路で届ける純機能追加は対象外**。

### 1.3 追加の阻害要因

- **Lost-in-the-Middle** (Liu et al. 2024, TACL): 長文中央の grounding は無視されやすい
- **Claude 4.6/4.7 で末尾 assistant prefill 非サポート化**: 「直前の assistant 発話を継ぎ足す」古典手は使えない
- **`<system-reminder>` への警戒訓練**: Anthropic は harness 注入されたリマインダを「外部からの参照情報・指示」として扱うよう Claude を訓練している (system_prompts_leaks 確認)

### 1.4 結論

> **Claude は「role の境界 (user/assistant 交互の turn)」を「会話の続き」と認識するトリガーにする。role の無い塊 (system / system-reminder) は『指示・参考資料』として読む。**

現状の SessionStart hook stdout 注入は **role が無い**ため、Anthropic 公式の「会話履歴」インターフェースを通っていない。これが根本原因。

---

## 2. 解決方針 (v0.5 = D ルート)

**Claude Code 自身の transcript JSONL (`~/.claude/projects/<proj-slug>/<session-id>.jsonl`) に、前任セッションの user/assistant turn を本物の role 付きで append する。**

これにより:
- Claude Code が次回 user prompt 処理時に JSONL を読み、Anthropic API への `messages=[...]` 配列を構築する際に、append した turn が `{role: 'user' | 'assistant', ...}` として含まれる
- Claude にとっては「自分の前回の発話」「ユーザーの前回の発話」として扱われる = synthetic assistant messages 路線 (Anthropic 公式推奨)
- `<system-reminder>` 経路を完全に脱出する

### 2.1 採用しない代替案

短期改善策として A (XML タグ + フレーミング強化) / B (注入末尾を user 保留 turn で締める) / C (CLAUDE.md 動的注入) があるが、いずれも **role を持たない場所での誤魔化し** であり、根治しない。本計画は最初から D で完治を目指す。

短期 mitigation として A/B を入れるかは Phase 0 spike の進捗を見て判断する (Phase 0 が長引いた場合のみ検討、原則は D 一本で進む)。

### 2.2 適用範囲: Claude path 専用 (Codex path は対象外)

本計画の transcript inject は **Claude session** (= 非 `codex:*` の session_id) の `~/.claude/projects/<proj-slug>/<session-id>.jsonl` への append のみを扱う。Codex session (`codex:<thread_id>`) は対象外。理由:

- Codex は SessionStart hook を持たない ([src/cli/install.mjs](../src/cli/install.mjs) の Codex hook 登録は `UserPromptSubmit` / `PostToolUse` / `Stop` のみ)。よって `/clear` 後の hook タイミングで append する経路自体が存在しない
- Codex rollout JSONL の format は Anthropic Messages API 互換ではなく `event_msg` / `function_call` 系の独自構造で、user/assistant role 復元の対象として扱えない
- Codex の context refresh は既に `trim --execute --host codex` の rollback + memory inject 経路で別解決されている (現行 v0.4.x の仕組みを維持)
- Claude predecessor lookup は元から `session_id NOT LIKE 'codex:%'` で Codex を除外しているため ([src/session-start.mjs:53-67](../src/session-start.mjs#L53-L67))、Claude session と Codex session が相互に merge されることはない

**ドキュメント反映**: Phase 3-1 で CHANGELOG / README に「v0.5.0 の transcript inject は Claude session 限定。Codex session の引き継ぎは v0.4.x と同じ rollout-based refresh を継続」を明示する。

### 2.3 PUBLIC_RELEASE_PLAN §0 への準拠

- silent try/catch 禁止
- `exit(0)` でのエラー隠蔽禁止
- フォールバック / 「念のため」のロジックを足さない
- transcript JSONL append が失敗するなら、その理由を stderr に出して explicit error にする (既存 hook と同じポリシー)

---

## 3. 段階実装

### Phase 0 — spike (検証 only、本実装の go/no-go を決める)

**目的**: SessionStart hook 内で `transcript_path` (payload に来る新セッションの JSONL パス) に user/assistant turn を append すると、**`/clear` 直後の新セッションで Claude がそれを「自分の過去発話」として読むか** を確認する。spike の検証条件は本計画が実際に動かしたい条件 (`/clear` 直後の SessionStart hook タイミング) と一致させる。

- [ ] Phase 0-1: 既存 transcript JSONL の shape をリバースする
  - [ ] `~/.claude/projects/-home-kite-projects-Throughline/` 配下の現セッション JSONL (例: `05735717-3f9a-445c-a4d3-5cf06e1681da.jsonl`) を 1 件 read
  - [ ] **全フィールドを網羅的に列挙** (例示にとどめない): user turn 行は `parentUuid` / `isSidechain` / `promptId` / `type` / `message` / `uuid` / `timestamp` / `permissionMode` / `userType` / `entrypoint` / `cwd` / `sessionId` / `version` / `gitBranch` を持つ実例があるため、すべて拾う
  - [ ] assistant turn 行のフィールドも同様に網羅 (`message.id` / `message.model` / `message.usage` / `requestId` 等が増える)
  - [ ] attachment 行 (`type:"attachment"`) のサブタイプ (`hook_success` / `hook_additional_context` / `ai-title` / `queue-operation` / etc.) を列挙
  - [ ] `tool_use` / `tool_result` / `thinking` / `image` の content block の型と、`tool_use.id` ↔ `tool_result.tool_use_id` の対応関係を確認
  - [ ] **記録先**: 本ファイル §6 「JSONL shape リバース結果」セクション
  - [ ] DB の `details` テーブル保存形式 (`input_text` / `output_text` が raw text か JSON.stringify 済みか) の確認は Phase 1-1 着手前に実施 (spike では不要)
- [ ] Phase 0-2: `/clear` 直後 SessionStart hook タイミングでの append spike (本計画の根本条件)
  - [ ] 検証用の throwaway Throughline DB session 1 件を仕込む (user turn 1 件 + assistant turn 1 件)
  - [ ] Throughline session-start.mjs に spike モードの分岐を一時追加: 「stdout 注入の代わりに transcript_path へ user/assistant turn を append する」
  - [ ] **spike モードの起動方法**: 環境変数は使わない (Claude Code が VSCode 拡張から起動された場合、ユーザーシェルの env が hook プロセスに伝播しない既知の問題 — [src/cli/install.mjs](../src/cli/install.mjs) で PATH 解決に苦労した経緯と同根)。代わりに marker file `~/.throughline/spike-inject.flag` の存在で判定する (cwd / parent process と独立)
  - [ ] 実 Claude Code セッションで marker file を作成し、その状態で **`/clear` を実行**、新セッションの SessionStart hook が走るタイミングで append される状態を作る
  - [ ] 新セッション開始直後に「続きよろしく」など短い prompt を送り、Claude が **append した前回 turn を自分の過去発話として認識する** か確認
  - [ ] (補助) throwaway session で「append → 同 session 内 user prompt」も比較として実行し、`/clear` 経路と挙動が一致するか比較する。**判定の主軸は `/clear` 経路の方**
  - [ ] **判定**: `/clear` 経路で認識すれば Phase 1 へ。認識しなければ no-go (撤退条件 §4 参照)。marker file は spike 終了後に削除する
- [ ] Phase 0-3: `transcript_path` の存在状態と書き込みタイミング
  - [ ] `/clear` 直後の新 session で SessionStart payload を log し、`transcript_path` の値を確認
  - [ ] その時点でファイルが既に存在するか / 空か / 何行あるか (ai-title などの先行行があるか)
  - [ ] hook stdout return の前に append しても Claude Code が race condition で消さないか確認
- [ ] Phase 0-4: hook 終了後の JSONL 持続性 + `parentUuid` chain 設計の検証 (本実装に必須の前提)
  - [ ] SessionStart hook 終了後、Claude Code が user prompt turn を JSONL に append する際、**hook が書いた行が保持されるか / 上書きされるか / 重複行になるか** を実機確認
  - [ ] **先行行の存在を前提にした chain 設計**: hook 起動時点で transcript_path には既に先行行 (`ai-title` / `queue-operation` / 自身の `hook_success` attachment) が書かれている可能性があるため、append する最初の user turn 行の `parentUuid` を:
    - (a) `null` (新規スレッド起点として扱う)
    - (b) 直前の attachment 行の `uuid` を参照
    - (c) 先行行を無視して我々が独自 chain を始める (= a と同等)

    の 3 案それぞれで実機検証する。**判定指標を明示**: 単に reader がクラッシュしないだけでなく、(a)/(c) 採用時に Claude Code が「親不在の孤立 turn」として別スレッド扱い (= 注入が会話履歴に乗らない) しないことを確認する。具体的には Phase 0-2 の「続きよろしく」prompt 投入時に append 済みの user/assistant turn が Claude の応答に effective に反映されたかどうかで判定する。実 transcript JSONL (`05735717-…jsonl` 行 5-6) では hook_success attachment 自身が `parentUuid` chain を成しているため、(b) が Claude Code の自然挙動と整合する第一候補
  - [ ] hook 書き込み完了が Claude Code 内部 reader からどう見えるか (fsync 必要性、O_APPEND atomicity の挙動) を Node.js / SQLite WAL の経験則に照らして確認
  - [ ] **判定**: 持続せず or 行重複が発生する場合は Phase 1-2 の本実装設計を見直す必要があり、Phase 1 着手前に Phase 0-4 を必ず通す。chain 設計案 (a-c) のうち成立するものを §6 に記録する

### Phase 1 — 本実装

Phase 0 が go の場合のみ着手。

- [ ] Phase 1-0: `HandoffRecord` の拡張 (前提タスク、Phase 1-1 より先)
  - [ ] 現行 [src/handoff-record.mjs](../src/handoff-record.mjs) の `references.l3` は `kind` / `toolName` / `sourceId` / `originSessionId` / `turnNumber` / `createdAt` / `detailCommand` のメタのみで、tool_use の `input` JSON / tool_result の出力テキスト / image base64 などの **payload 本体は含まれていない**
  - [ ] L3 を transcript JSONL に復元するため、新フィールド `references.l3Payloads` (または `references.l3` 内に `inputText` / `outputText` を opt-in 追加) として projection を新設。`tool_use.id` ↔ `tool_result.tool_use_id` の対応関係 (= `source_id` の chain) も含める
  - [ ] `handoff-record.test.mjs` の既存テストを破壊しない範囲で拡張 (追加フィールドの opt-in)
  - [ ] payload を持つ projection は **transcript inject 経路でのみ使う**。Codex projection 等の他の利用先は既存 shape を維持する
  - [ ] **既存利用先の test 追加**: [src/codex-handoff.mjs:130, 259, 352](../src/codex-handoff.mjs) は `record.references.l3` を `groupL3ByTurn` / `toDetailReference` に渡しているため、`src/l3-summary.mjs` の `groupL3ByTurn` が新フィールドを無視することを `codex-handoff.test.mjs` または `l3-summary` の専用 test で固定する
- [ ] Phase 1-1: `src/transcript-writer.mjs` 新規作成
  - [ ] 引数: `targetJsonlPath`, `record: HandoffRecord`, `newSessionId`, `cwd`, `version`, `gitBranch`
  - [ ] `HandoffRecord` の L2 (`recentBodies`) を user/assistant の JSONL 行に変換
  - [ ] **全必須フィールドを生成**: `parentUuid` / `isSidechain: false` / `promptId` / `type` / `message` / `uuid` (v4) / `timestamp` (元 createdAt 維持) / `permissionMode` / `userType` / `entrypoint` / `cwd` / `sessionId` / `version` / `gitBranch`。assistant 行は追加で `message.id` / `message.model` / `message.usage` / `requestId` を再現可能な値で埋める
  - [ ] tool_use / tool_result / thinking / image は L3 payload (Phase 1-0 で拡張済み) から content block として復元 (kind ごとに型を切替、tool_use.id ↔ tool_result.tool_use_id 対応を維持)
  - [ ] **payload parse 仕様**: Phase 0-1 で確認した `details.input_text` / `output_text` の保存形式に基づき、tool_use content block の `input` フィールドが `{...}` オブジェクトとして要求される場合は `JSON.parse(inputText)` を行う。raw text 保存だった場合の fallback (string のまま投入) も明示する
  - [ ] `parentUuid` chain: Phase 0-4 で確定した chain 設計 (a/b/c のいずれか) に従う。最初の append 行の親決定ロジックを明示
  - [ ] **idempotency**: 既に同 `origin_session_id` の turn が target JSONL に存在すれば no-op (重複 inject 防止)
- [ ] Phase 1-2: `src/session-start.mjs` の改修 (Phase 0-4 結果が go の場合のみ着手、純機能追加)
  - [ ] **Phase 0-4 が go (= hook が書いた行が Claude Code 側で保持され、chain 設計が成立) でない限り、Phase 1-2 には着手しない**。NG なら §4 撤退条件を発動し本計画 v0.5 は終了する
  - [ ] 現行 [src/session-start.mjs:91](../src/session-start.mjs) では `payload` から `transcript_path` を destructure していない。Phase 1-2 で取得を追加する
  - [ ] **実装順序の厳守** (現行 v0.4.12 体験を 100% 保証するため):
    1. 先に `process.stdout.write(text + '\n')` を**完全に**実行する (現行 v0.4.12 と完全同一の stdout 出力。L2 verbatim を含む全部)
    2. その**後**で `transcriptWriter.injectInto(transcript_path, record, session_id, ...)` を呼ぶ
    3. transcriptWriter が throw した場合は stderr に explicit error を出し、Phase 0-4 の検証結果を踏まえた idempotency 失敗等であれば exit 1。stdout 側は既に flush 済みなので最低限 v0.4.12 と同等体験は届く
  - [ ] `buildResumeContext` には**変更を加えない** (omit mode 追加もしない)。stdout で出る内容は v0.4.12 と一字一句同一
  - [ ] 注入完了を `inheritance-decision.log` に追記 (`injected_into_transcript: true / false`, `turns_appended: N`, `transcript_writer_error: <reason or null>`)

### Phase 2 — テスト & 検証

- [ ] Phase 2-1: 単体テスト
  - [ ] `src/transcript-writer.test.mjs` 新規作成
  - [ ] JSONL 行の shape が Claude Code の native フォーマットと一致するか (snapshot test)
  - [ ] idempotency (二重 inject 防止)
  - [ ] tool_use / tool_result / thinking の content block 復元
- [ ] Phase 2-2: 統合テスト
  - [ ] 既存の `src/session-start` E2E (or test 同等) で **stdout 出力が v0.4.12 と一字一句同一であることを確認** (現行 体験の完全保証)
  - [ ] transcript_path の append 後の内容が期待 shape と一致することを確認
  - [ ] `inheritance-decision.log` に新フィールド (`injected_into_transcript`, `turns_appended`, `transcript_writer_error`) が記録されること
- [ ] Phase 2-3: 実機検証
  - [ ] OpenCClaw or 別 project で `/clear` → 新セッションで「続き」と短く prompt → Claude が前回 turn から自然に続けるか
  - [ ] L2 が 30 turn を超えるケース、tool_use を含むケース、thinking を含むケースをそれぞれ確認
  - [ ] 失敗ケースを inheritance-decision.log と突き合わせて切り分け

### Phase 3 — リリース

- [ ] Phase 3-1: CHANGELOG.md と README.md 更新
  - [ ] v0.5.0 のセクションを CHANGELOG に追加 (現行 stdout 注入 + transcript JSONL への role 付き追加注入 の二重出力)
  - [ ] README の「中断地点からの再開」セクションに「v0.5 以降は L2 verbatim が transcript JSONL に role 付きで追加注入される」を追記 (stdout 注入の内容は不変であることを明示し、ユーザー混乱を避ける)
  - [ ] README の Troubleshooting に「v0.5 で挙動が怪しい場合の手動ロールバック手順 `npm i -g throughline@0.4.12 && throughline install`」を 1 行追加 (Phase 0-4 を通っての正式リリースなのでロールバックは想定外だが、保険として手順だけ載せる)
  - [ ] README の `npm install -g throughline` 後に `throughline install` の再実行が必要であることを upgrade 文脈で 1 度明示 (現行は初回 install のみの表現)
- [ ] Phase 3-2: 依存 docs 同期
  - [ ] CLAUDE.md の「設計の核」を v0.5 仕様に書き直す
  - [ ] `docs/02_clear_auto_handoff_plan.md` の現行仕様セクションに「v0.5 で transcript inject に移行」と追記
  - [ ] `docs/01_l1_l2_l3_redesign.md` の「SessionStart 注入内容」記述を v0.5 仕様に同期
- [ ] Phase 3-3: bump & publish
  - [ ] `package.json` を `0.5.0` に bump
  - [ ] `npm test` 全 green
  - [ ] 開発用 global 再インストール: `npm i -g .` + `throughline install` (現行 v0.4.x と同じ 2 段手順、変更なし)
  - [ ] `throughline --version` で 0.5.0 確認
  - [ ] `throughline doctor` で SessionStart hook の登録経路を確認
  - [ ] (Codex hooks 関連の差分確認や旧 hook 手動編集ガイダンスは D の scope 外。別 issue / 別計画で扱う)
- [ ] Phase 3-4: 実 commit & push
  - [ ] git commit (Co-Authored-By: Claude)
  - [ ] git push origin main

---

## 4. リスクと撤退条件

| リスク | 撤退条件 | 撤退時の代替 |
| --- | --- | --- |
| Claude Code が JSONL に append された行を読まない | Phase 0-2 (`/clear` 経路) で append しても Claude が認識しない | A+B (XML タグ + bridge turn) の短期改善で代替、Agent SDK 化 (E) を中期検討 |
| JSONL format が Claude Code minor update で破壊的変更 | Phase 2-3 実機検証で再現性が崩れる | **stdout 注入は現行のまま完全に届くため、ユーザー体験の最低ラインは v0.4.12 と同等が保証される** (純機能追加設計の最大の利点)。transcript writer の write 失敗は stderr に明示エラーを出して `inheritance-decision.log` に記録するのみ。stdout 経由 fallback は不要 (元々 stdout は出ている)。v0.4.x への手動ロールバック (`npm i -g throughline@0.4.12 && throughline install`) は安全策として README Troubleshooting に手順だけ載せる |
| `transcript_path` のファイルが SessionStart hook 完了後に新規上書きされる | Phase 0-3 / 0-4 で確認 | hook 終了タイミング後の write timing を Claude Code update で追従、もしくは別経路 |
| tool_use / tool_result の chain 整合性 (`tool_use_id` 対応関係) が崩れて Claude Code がエラー | Phase 2-1 単体テストで shape 不整合検出 | L3 詳細の inject は諦め、L2 (text only) のみ inject (tool 関連はそのままユーザー側の参考情報) |

---

## 5. 関連 docs

- [docs/02_clear_auto_handoff_plan.md](02_clear_auto_handoff_plan.md) — v0.4 系の baton/auto path 現行仕様 (本計画で部分上書きされる)
- [docs/01_l1_l2_l3_redesign.md](01_l1_l2_l3_redesign.md) — L1/L2/L3 記憶レイヤー設計 (本計画で SessionStart 注入の分担が変わる)
- [docs/04_public_release_plan.md](04_public_release_plan.md) — §0 フォールバック禁止ルール、CLI 設計
- [src/resume-context.mjs](../src/resume-context.mjs) — 現行の system 側注入 builder (**v0.5 で変更なし**)
- [src/session-start.mjs](../src/session-start.mjs) — 注入の呼び出し元 (v0.5 で transcript writer 呼び出しを stdout 注入の直後に追加)
- [src/handoff-record.mjs](../src/handoff-record.mjs) — 注入の中間表現 (v0.5 で L3 payload を opt-in 追加)

---

## 6. 作業ログ / 発見事項

### JSONL shape リバース結果

**対象**: `~/.claude/projects/-home-kite-projects-Throughline/c8939fe4-0147-45b5-a12e-0ebc48674846.jsonl` (1616 行、Claude Code v2.1.145)

**行 type 一覧** (Phase 0-1 着手時点で出現したもの):

| 行 type | 件数 | 役割 |
| --- | --- | --- |
| `ai-title` | 83 | session ラベル更新 |
| `queue-operation` | 28 | UI 内部キュー操作 |
| `attachment.hook_success` | 550 | hook 実行成功 (stdout 持ち) |
| `attachment.hook_additional_context` | 2 | 構造化 JSON 出力の parsed additionalContext |
| `attachment.async_hook_response` | 554 | async hook 応答 |
| `attachment.deferred_tools_delta` | 2 | 遅延 tool 一覧の差分 |
| `attachment.mcp_instructions_delta` | 2 | MCP 指示の差分 |
| `attachment.skill_listing` | 1 | skill 一覧 (29 KB の content 例あり) |
| `attachment.auto_mode` | 1 | auto mode フラグ |
| `attachment.todo_reminder` | 12 | TodoWrite リマインダ |
| `attachment.queued_command` | 1 | キュー投入済みコマンド |
| `attachment.command_permissions` | 1 | コマンド権限通知 |
| `attachment.date_change` | 1 | 日付変更通知 |
| **`user`** | 91 | **ユーザー発話 turn (D の主役)** |
| **`assistant`** | 181 | **アシスタント発話 turn (D の主役)** |
| `system` | 11 | システム通知行 |
| `file-history-snapshot` | 14 | ファイル履歴 |
| `last-prompt` | 81 | 直近 prompt のサマリ |

**user turn の shape** (plain text 投稿、line 8):

```text
top-level fields (14): parentUuid, isSidechain, promptId, type="user", message,
  uuid, timestamp, permissionMode, userType, entrypoint, cwd, sessionId, version, gitBranch
message: { role: "user", content: [{type: "text", text: "..."}] }
```

**user turn の shape** (tool_result、line 21):

```text
top-level fields (15): parentUuid, isSidechain, promptId, type="user", message,
  uuid, timestamp, toolUseResult (string、エラー時 "Error: ..."), sourceToolAssistantUUID,
  userType, entrypoint, cwd, sessionId, version, gitBranch
  *** permissionMode は無い (plain text 用と差) ***
message: { role: "user", content: [{type: "tool_result", tool_use_id, is_error, content: string}] }
```

**assistant turn の shape** (text / tool_use / thinking すべて共通の top-level、line 16-17, 24):

```text
top-level fields (13): parentUuid, isSidechain, message, requestId, type="assistant",
  uuid, timestamp, userType, entrypoint, cwd, sessionId, version, gitBranch
  *** promptId, permissionMode は無い ***
message: { model, id, type, role: "assistant", content: [...], stop_reason,
           stop_sequence, stop_details, usage, diagnostics }
content block 型:
  - text:     { type: "text", text }
  - tool_use: { type: "tool_use", id, name, input (object), caller }
  - thinking: { type: "thinking", thinking (string), signature (string、Base64 様 ~516 chars) }
```

**parentUuid chain 構造** (line 1-12 実観察):

```text
line 1: ai-title           (parentUuid=なし, uuid=なし)        # chain 対象外
line 2: ai-title           (parentUuid=なし, uuid=なし)
line 3: queue-operation    (parentUuid=なし, uuid=なし)
line 4: queue-operation    (parentUuid=なし, uuid=なし)
line 5: attachment.hook_success            (parentUuid=null,     uuid=f010915c) ← chain 起点
line 6: attachment.hook_success            (parentUuid=f010915c, uuid=06561958)
line 7: attachment.hook_additional_context (parentUuid=06561958, uuid=32751232)
line 8: user (最初の本物 user-turn)         (parentUuid=32751232, uuid=074e15dc)
```

**確定事項**:
- chain 起点は SessionStart hook の最初の attachment 行 (`parentUuid: null`)
- 以降は直前の行の `uuid` を `parentUuid` として参照する単一 chain
- ユーザーの最初の user-turn (line 8) は直前 attachment (line 7) の uuid を親に取る
- **Phase 0-4 chain 設計案 (b)「直前の attachment 行の uuid を参照」が Claude Code の自然挙動**

**Phase 1-1 が生成すべき必須フィールド** (上記網羅):

- user turn (plain): `parentUuid` / `isSidechain: false` / `promptId` (v4) / `type: "user"` / `message: {role, content}` / `uuid` (v4) / `timestamp` / `permissionMode` / `userType: "external"` / `entrypoint` / `cwd` / `sessionId` / `version` / `gitBranch`
- user turn (tool_result): 上から `permissionMode` を除き、`toolUseResult` (string) + `sourceToolAssistantUUID` を追加
- assistant turn: `parentUuid` / `isSidechain: false` / `message: {model, id, type, role, content, stop_reason, stop_sequence, stop_details, usage, diagnostics}` / `requestId` / `type: "assistant"` / `uuid` / `timestamp` / `userType` / `entrypoint` / `cwd` / `sessionId` / `version` / `gitBranch`

**DB `details` 保存形式の確認は Phase 1-1 着手前に実施** (本 spike では transcript shape の網羅で足りる)。

### Phase 0 spike 結果

#### 2026-05-23 実機ラン 1 (バグ修正前 → 修正後 → tracer 入り)

**ラン (a) — `93d95803` `/clear`**

- spike 結果: `{ appended: 0, parentUuidStart: null, skipReason: 'no_record_or_empty_l2' }`
- 原因: `buildHandoffRecord(db, newSessionId)` の第二引数を string 直渡しにしていたため `sessionId` が undefined になり、即 null 返却 → silent skip。
- 修正: `buildHandoffRecord(db, { sessionId: newSessionId, isInheritance: true })`。

**ラン (b) — `f4500b59` `/clear` (修正後)**

- spike 結果: `{ appended: 26, parentUuidStart: null }`
- JSONL 持続性: ✅ 注入 26 行 (line 1-26) は Claude Code の後続書き込み (line 27 以降) で上書きされず保持。
- **chain 整合性: ❌ 計画と乖離**:
  - line 1 (最初の spike user): `parentUuid: null` ← spike 実行時点で `transcript_path` が空だったため `readLastUuid` が null を返した。
  - line 27 (Claude Code 最初の `attachment.hook_success`): こちらも `parentUuid: null` 起点。**Claude Code 自身が新規 chain を null から開始** し、我々の line 26 を親に取らなかった。
  - 結果: spike chain と Claude Code chain が **同一 JSONL 内に平行な 2 本** として並存。最終 user prompt (line 30) の親を遡ると 29 → 28 → 27 → null で、spike chain には到達しない。
- **計画 §3 Phase 0-4 (b) の前提誤り**: 「直前 attachment 行の uuid を参照」は SessionStart hook 実行時点では成立しない。なぜなら `hook_success` attachment は **hook 完了後** に Claude Code が書くので、hook 実行中の `transcript_path` には attachment 行がまだ存在しない。よって SessionStart hook タイミングでは構造的に (b) 不可、デフォルトで (a) になる。
- モデル可視性判定: ⚠️ 今回は判定不能。spike 行の text 内容と stdout 注入 (resume-context) の L2 verbatim 内容が一致しているため、Claude の応答が「JSONL 経由」か「stdout 経由」か切り分けられない。

#### 切り分け方針 (ラン (c) 以降で実施)

- spike-transcript-writer に **tracer** (`crypto.randomBytes(4).toString('hex')`) 機能を追加 — 末尾 assistant 行 text にのみ `\n\n[spike-tracer: <8 hex>]` を suffix。stdout 注入 (DB 由来) には含まれない値。
- session-start hook が tracer を生成して spike に渡し、`inheritance-decision.log` の `spike_result.tracer` に記録。
- 次の `/clear` 後にユーザーが「直前の発話で言った合言葉を 1 つだけ返して」と短く尋ね、Claude が tracer を再現できるかで JSONL 経路のモデル可視性を判定する。

#### 構造的に検証する代替架構 (tracer 結果次第)

ラン (b) で判明したように、`/clear` 直後の SessionStart hook 内で (b) を実装するのは不可能。tracer が「再現できない」結果なら、(a) 孤立 chain ではモデルに届かないことになるので、以下のいずれかを Phase 0-5 として追加検証する:

1. **UserPromptSubmit hook 経路**: 最初の user prompt 投入直前なら attachment 行 (27-29) が書き終わっており、`readLastUuid` でその uuid を取れる。spike を SessionStart から UserPromptSubmit に移動して (b) を成立させる。
2. **SessionStart の detached subprocess**: 親 hook は即 return、子プロセスが `transcript_path` の hook_success 出現を fsync poll して chain を再構築。タイミング fragile。
3. **chain を作らない**: そもそも Claude Code reader が parentUuid chain 探索ではなく単純 sequential read であれば (a) でも届く可能性がある。tracer で結論が出る。

優先度: tracer 結果 → (a) で届くなら現行のまま Phase 1 へ。届かないなら (1) UserPromptSubmit 経路を Phase 0-5 として検証。

#### 2026-05-23 実機ラン 2 (tracer 入り = 仮説 A 確定実験)

**ラン (c) — `5236a0ba` `/clear` (tracer 入り spike)**

- spike 結果: `{ appended: 40, parentUuidStart: null, tracer: 'b93be22c', tracerAppendedAt: 39 }`
- JSONL 検査: line 40 末尾に `[spike-tracer: b93be22c]` が確実に書き込まれている (uuid=33eb2f5a)。
- Claude Code 側の chain: line 41 `attachment.hook_success` が `parent=null` で開始 (我々の line 40 uuid を親に取らない)。
- 検証プロンプト: `直前のセッション末尾の assistant 発話に [spike-tracer: ◯◯◯◯◯◯◯◯] の形で 8 文字の合言葉が埋め込まれているはず。ファイル参照禁止・message history のみで その 8 文字だけ返して。覚えていないなら「ない」と答えて。`
- 新セッション (cleared-me) の応答: **「ない」** — tracer を message history から再現できなかった。
- **結論**: 仮説 A (Claude Code は parentUuid chain を辿って messages=[] を構築する) を **確定**。孤立 chain のターンは モデルの message 履歴に乗らない。設計案 (a) は dead。
- これにより §3 Phase 0-2 / 0-4 の go-no-go 判定は **no-go (現行の SessionStart 注入アーキ)**。ただし transcript 注入そのものを諦めるのは早い: chain-reachable 注入が可能なら届く可能性がある (§3 Phase 0-5 で検証)。

### Phase 0-5 — UserPromptSubmit 経路 spike (chain (b) 成立条件)

**目的**: chain (b) 「直前 attachment 行の uuid を親に取る」を実機で成立させ、tracer がモデルから再現できるかを検証する。SessionStart hook 時点では transcript_path が空で (b) 不可だったが、UserPromptSubmit hook 時点では SessionStart の `hook_success` / `hook_additional_context` 行が JSONL に書かれているため `readLastUuid` で親 uuid を取れる。

- [ ] Phase 0-5-1: `src/prompt-submit.mjs` の UserPromptSubmit hook に spike 分岐を追加
  - [ ] 起動条件 (3 条件 AND): marker file `~/.throughline/spike-inject.flag` 存在 / 当該セッションは merge 成立済み (sessions.merged_into IS NULL かつ 別の predecessor から merge を受けた = bodies に origin != session_id がある) / 当該セッションでまだ spike を打っていない (新マーカー `~/.throughline/spike-prompt-marker/<session_id>` で per-session idempotency)
  - [ ] spike 実行内容: `spikeInject` を再利用、`targetJsonlPath = transcript_path`、tracer 生成、`readLastUuid` で親 uuid を取得 (今回は **空ではない** = chain-reachable)
  - [ ] 注入完了を `~/.throughline/logs/prompt-spike.log` に記録 (tracer, parentUuidStart, appended)
- [ ] Phase 0-5-2: `transcript_path` が UserPromptSubmit payload に含まれるかを実機検証 (Claude Code 2.1.x のスキーマ)。含まれない場合は payload の session_id から JSONL パスを構築する fallback を入れる
- [ ] Phase 0-5-3: spike 実行後にユーザーが短い prompt を送る (本実装では同じ prompt = spike を起動した prompt)。新しい /clear 後ではなく **同セッションの最初の prompt 投入時の hook 内で spike を打つ** ことに注意。検証プロンプトは `直前のセッション末尾の assistant 発話に [spike-tracer: ...] の形で…` を 2 通目として送る (1 通目で spike が走り、2 通目で再現テスト)
  - [ ] Claude Code は UserPromptSubmit hook 戻り後の prompt を構築する際、JSONL の新規行を消費するか?  → chain (b) でも届かない場合、Phase 0-5 は no-go で、transcript JSONL 経路は完全に断念。
- [ ] Phase 0-5-4: 結果記録と go-no-go 判定
  - [ ] go: tracer 再現成功 → Phase 1 を「UserPromptSubmit ベース」に修正して着手
  - [ ] no-go: 別経路 (E: Agent SDK; A+B: 短期 mitigation) を検討するか、現行の stdout 注入のまま継続する判断

#### 2026-05-24 Phase 0-5 実測結果 — **D 経路 dead 確定**

3 通りの構成で実機検証、すべて「ない」:

| ラン | timing | chain | model 名 | /clear 経路 | spike log | モデル応答 |
| --- | --- | --- | --- | --- | --- | --- |
| (1) Phase 0-2 | SessionStart | (a) null orphan | claude-throughline-spike | text | `appended: 40, tracer: b93be22c, parent_uuid_start: null` | **ない** |
| (2) Phase 0-5 初回 | UserPromptSubmit | (b) chain-reachable | claude-throughline-spike | text | `appended: 40, tracer: 20084924, parent_uuid_start: b9543a8a` | **ない** |
| (3) Phase 0-5 retry | UserPromptSubmit | (b) chain-reachable | **claude-opus-4-7** | text | `appended: 40, tracer: 1a430bf5, parent_uuid_start: 85dc918d` | **ない** |
| (4) Phase 0-5 retry (cleaner) | UserPromptSubmit | (b) chain-reachable | claude-opus-4-7 | text (confirmed) | `appended: 40, tracer: 85584dfe, parent_uuid_start: 3c0bd094` | **ない** |

**ラン (2) の JSONL chain 分析** (`e85d7b1a` session):

```text
line 1-3: CC SessionStart の hook_success / hook_additional_context
line 4-9: CC 内部の system / queue-operation / last-prompt (chain は b9543a8a で終わる)
line 10-49: 我々の spike 注入 40 ターン (parent=b9543a8a から chain (b) 連結成功)
line 50: ユーザーの tracer 再現 prompt — parent=b9543a8a (= line 6)
```

CC は **line 50 の parent を line 49 (= 我々の最後の注入行) ではなく line 6 にした**。我々の chain と CC の chain は同じ b9543a8a から **分岐した姉妹** であって、line 50 から親方向に遡っても spike 注入には到達しない。

**根本原因 (構造的)**: Claude Code は新ターンの `parentUuid` を **自プロセス内のメモリ状態** から決定し、JSONL ファイルを読み直さない。よって hook 内で外部から JSONL に何 turn 追加しようと、CC が次に書く user turn の親は変わらない。これはアーキ的制約で、tracer 再現がどの構成でも不可能。

**確定した dead 構成**:

- すべての hook timing (SessionStart / UserPromptSubmit) — CC 側 chain は in-memory で決まる
- すべての chain 設計 (a) 孤立 / (b) chain-reachable from attachment — CC は無視
- すべての assistantModel (偽名 / 実 Claude モデル名) — 内容フィルタは無関係

**まだ試していない理論的選択肢** (実装重 or 副作用大で実用上不適):

- (3) JSONL を CC の書き込み直後に書き換える race — atomic ではなく、CC 内部状態とファイル状態が乖離して破綻リスク
- (4) `hookSpecificOutput.additionalContext` 経由 — これは "attachment" 扱いで messages[] には乗らず、stdout と同じカテゴリ。やる価値なし。

**結論**: D 経路 (transcript JSONL inject) は本計画の前提下では **完全 dead**。Phase 1 着手は不可。

**進捗ステータス §7 の更新**: Phase 0 spike → 完了 / no-go 判定。Phase 1-3 は本計画下では着手不可。後継として A / B / E のいずれかを別計画として起こす。

### Phase 0-6 — `hookSpecificOutput.initialUserMessage` 経路 spike

**目的**: D 経路 dead 確定後の最終候補として、Claude Code 公式の `hookSpecificOutput.initialUserMessage` フィールドが **interactive モードでも** first user message として messages[] に乗るかを実機検証する。openclaude OSS 実装のソースコメントは「headless 専用」と明記しているが、real CC の挙動は未確認だった。

**起動方法**: marker file `~/.throughline/initial-user-message-test.flag` 存在時、SessionStart hook は plain stdout の代わりに JSON 出力 (`hookSpecificOutput.initialUserMessage` に tracer 入りメッセージ) に切り替える。flag 削除で即復帰、本流に副作用なし。

#### 2026-05-24 実機ラン 1 / 2

| ラン | tracer | session_id | 検証 prompt | モデル応答 |
| --- | --- | --- | --- | --- |
| (1) 12:34 | `1cc4a88a` | `063dea0f-…` | (未実行 — 検証 prompt を送る前に v2.1 header 強化に pivot) | — |
| (2) 13:33 | `9220a79c` | `0979ad20-…` | `直前セッション開始時に [initial-user-tracer: XXXXXXXX] の 8 hex が hookSpecificOutput.initialUserMessage 経由で届いてるはず。…` | **ない** |

**結論**: openclaude source comment 「HEADLESS-ONLY」を **実機でも確認**。`initialUserMessage` は interactive `/clear` シナリオでは messages[] に乗らない (= 第二仮説も反証済み)。

**Throughline plugin scope での結論**: D 経路と `initialUserMessage` 経路の双方が dead、PreCompact 第三仮説は別計画扱い、Agent SDK pivot (道 B) は plugin scope 外。**plugin として達成可能な最終形態は 道 C (v2.1 header + 現在地 anchor、commit `987efc0` / `1a44027`)** と確定。本計画 v0.5 は 道 C を v0.5.0 として release する形で完了する。

### Phase 1 実装メモ

(本計画では着手しない。後継として A / B / E が必要になった場合は別計画として起こす)

---

## 7. 進捗ステータス

- [x] Phase 0 spike 完了 / no-go 判定 (D / `initialUserMessage` 両 dead 確定、2026-05-24)
- ~~Phase 1 本実装~~ — 着手せず (no-go により本計画下では不可)
- ~~Phase 2 テスト~~ — 着手せず
- [x] Phase 3 リリース (v0.5.0) — 道 C (v2.1 header + 現在地 anchor) を plugin scope での完成形として release。本計画は履歴 doc として保存し、後継 (A / B / E) は別計画として起こす
