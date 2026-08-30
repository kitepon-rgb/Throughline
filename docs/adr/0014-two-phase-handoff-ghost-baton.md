# ADR 0014: 二相ハンドオフ — 幽霊SessionStartによるバトン奪取の排除と注入10k予算

日付: 2026-07-17

## Status

Accepted（実装済み・live acceptance 済み — 本ADR末尾の記録参照）。

## Context

### Incident: バトンが幽霊セッションに奪われ、実セッションが記憶ゼロで始まる

2026-07-17、dotagentsで同日2回（10:33 JST / 16:39 JST）、`/tl` バトンによる引き継ぎが
沈黙して失敗した。`~/.throughline/logs/inheritance-decision.log` と DB の実測:

- Claude Code は同一 project_path に対し短時間（実測 315ms / 488ms 差）に複数の
  SessionStart hook を発火させることがある。うち一部は **transcript を一度も生成せず、
  sessions 行の updated_at が誕生時刻のまま二度と動かない「幽霊セッション」** になる。
- 旧実装は SessionStart で `consumeBaton`（BEGIN IMMEDIATE の SELECT+DELETE）→ merge →
  stdout 注入を行っていたため、**先着した幽霊がバトンを消費して前任の全記憶
  （skeletons 16件 / bodies 84件等）を吸い込み**、数百ms後の実セッションは
  `baton_skip_reason: "missing"` で記憶ゼロで始まった。
- 全期間実測: 同一projectで2秒以内の SessionStart ペアは 3,222 イベント中 56 ペア
  （= 近接ダブル発火は日常的）。バトン存在時に近接ペアが起きた 2 回は 2 回とも幽霊が勝った。
- 2026-05 の auto path でも、受け取り側 transcript が存在しない merge が 6 件あり、
  幽霊 twin（source='clear' の二重発火）が前任に選ばれた形と整合する。

**SessionStart 時点では実体と幽霊を判別する情報が原理的に存在しない。**
実測で、本物のセッションの transcript ファイルも SessionStart hook 発火の約 461ms
**後** に作られる（payload の `transcript_path` は「これから作られる予定のパス」）。
したがって「消費前に transcript 実在を検査する」案は本物も全部弾いて成立しない。

### 第二の欠陥: hook stdout 注入は10k超で file 化され、モデル可視が先頭2KBに劣化する

対策検証中の実測（Claude Code 2.1.211、tracer 実験 + 全 transcript 掃引）:

- SessionStart / UserPromptSubmit の hook stdout は約 10,000 字を超えると
  `<persisted-output>`（保存ファイルパス + 先頭 2KB preview）に置換され、
  **モデルに inline で見えるのは先頭 2KB だけ** になる。
  9,501 字は inline 通過、15,286 字は file 化を確認。
- 実運用の SessionStart 注入で 10k 超だった 12 件（2026-06-28 / v2.1.195 以降の全件）は
  **12 件全部が劣化していた**（例: 64,148 字 emit → 可視 2,054 字）。
  L1+L2 本体はモデルに読まれておらず、ヘッダ + 現在地アンカーが偶然 2KB 内に
  収まっていたため引き継ぎが機能している風に見えていた。

## Decision

### 二相ハンドオフ（merge・注入を「実体の証明」まで遅延する）

1. **SessionStart（第一相）は intent 登録のみ**。sessions INSERT と
   `pending_handoffs`（schema v9）への登録だけを行い、consumeBaton / merge / 注入を
   一切しない。auto path（source='clear'）の前任はこの時点で解決して
   `auto_predecessor_id` に凍結する。
2. **最初の UserPromptSubmit（第二相）が consume + merge + 注入を行う**。
   プロンプト到達 = セッション実在の証明であり、幽霊は構造上ここに到達できない。
   pending 行の consume は BEGIN IMMEDIATE で atomic（1 セッション 1 回）。
3. **baton 適格性はセッション誕生時刻基準**: `age = pending.created_at - baton.created_at`
   が `0 ≤ age ≤ TTL(1h)` のときだけ消費。負 age（自分の誕生後に書かれたバトン）は
   **削除せず残置**（`future_baton`）— 走行中セッションの横取りと、multi-window で
   本来の後継のバトンを先食いする穴を同時に塞ぐ。TTL の意味論
   「/tl から新セッション開始までの猶予」は消費が遅延しても保存される。
4. **auto path の前任候補に transcript 実在フィルタ**（導出パス or state file）。
   幽霊 twin は transcript を持たないため前任に選ばれない（2026-05 型の再発防止）。
   実前任は /clear 前に活動していた実体なので必ず transcript を持つ。
5. **注入は10k予算内レンダリング** (`buildBudgetedResumeContext`, 上限 9,500 字):
   ヘッダ + 現在地アンカーは常に全文、L1 → L2 の順に新しい側から予算まで詰め、
   省略した行数は**注入文内に明示**し decision log にも記録する（黙って切らない）。
   最新 L2 行が単体で予算超過なら切り詰めて `throughline detail` 参照を付す。
6. 幽霊の pending 行は誰にも consume されず無害に残る（数百バイト/行）。
   TTL ベースの GC は**入れない** — 長時間 idle 後の初回プロンプトから引き継ぎを
   silent に奪う fallback になるため。
7. 判定ログは `phase: 'session-start' | 'prompt-submit'` の2種を同じ
   inheritance-decision.log に記録する（本 incident の一次証拠となった実績を保つ）。

### 廃止・撤去

- SessionStart の注入経路と、それにぶら下がっていた Phase 0-2 spike /
  Phase 0-6 `initialUserMessage` テスト分岐（docs/archive/10 で両 no-go 確定済みの実験残骸）。
- 「UserPromptSubmit は注入しない」規約 — 理由だった「SessionStart との二重注入」が
  SessionStart 注入の廃止で消滅したため、注入責務ごと UserPromptSubmit へ移す。

## Acceptance

実装 gate（2026-07-17、このMacで実施済み）:

- `npm test` 680/681 PASS（1 skip は既存の win32 契約 skip）。
- 新規回帰テスト: 幽霊先着 SessionStart がバトンを奪えず、実セッションの初回プロンプトが
  記憶を受け取る（incident 再現形）/ 走行中セッションが future baton を奪えない /
  bornAt 基準 TTL / pending consume の1回性 / 予算レンダリングの省略告知・切り詰め。
- 10k 実測: 一時 UserPromptSubmit hook + `claude -p`（Haiku）の tracer 実験で、
  11,953 字 stdout の 10k 境界後 tracer がモデル不可視、`<persisted-output>` 化を確認。

Live acceptance（2026-07-17、このMacで dev 版 global install 後に実施）:

- [x] 実 Claude Code（headless、実 hooks 経由）で、記憶セッション → `/tl` → 新セッション
      初回プロンプトの引き継ぎを確認。後継が合言葉を即答し、decision log に
      `phase=session-start`（pending_registered）→ `phase=prompt-submit`
      （`triggered_path=baton`, `merged=true`, injection 2,095 字・省略ゼロ）が刻まれた。
      DB は初回 hook 発火で v9 へ migrate（session `8452e936`、前任 `c8b485bd`）。
- [x] 自己バトン食いの不在を実機確認: `/tl` を打った resume セッション自身の pending は
      `baton missing` で消化され（消費が baton 書込より先）、バトンは後継まで残った。
      `baton_age_ms` は誕生時刻基準（21,200ms）で記録された。
- [x] 幽霊2体（c4f05b96 / 90cb0c0e）の記憶回収済み（skeletons 30 / bodies 166 /
      details 2,247 を実セッション `9fb15563` へ。DB バックアップ
      `throughline.db.backup-20260717-ghost-recovery` 取得済み）。
- [ ] multi-window での近接 SessionStart 実機再現は未実施（幽霊の発生タイミングを
      任意に誘発できないため。回帰は subprocess テストの incident 再現形で担保）。

## 関連

- 幽霊 SessionStart 自体は Claude Code 側の挙動（upstream 報告は別トラック）。
- 10k persisted-output は third-party 仕様として rag/01-hooks に実測記録。
