# 12 — Desktop /clear 引き継ぎ + L2 捕捉完全性 改良プラン

<!-- 前提: Fable級統括／実装は codex_work・composer 委譲主体（2026-07 時点） -->

status: **承認済み・実装中**（2026-07-11 オーナー承認。本文書が正本＝チェックボックスが TODO を兼ねる）

## 統括の型（orchestrate スキル準拠。配置は 02_models.md 決定表の引用必須 — 2026-07-11 オーナー裁定の書式）

配置宣言は正典 dotagents/docs/02_models.md を開いて該当行を写す。引用なしの配置は書かない。本プランの根拠行（引用・2026-07-11 時点）:

- **実装物量**（02_models.md:40）:「中位=`gpt-5.6-terra`×medium・codex_work」＋「`grok-composer-2.5-fast`＝並ぶ第一選択（仕様固定＋検証コマンド必須の委譲契約を厳守）」
  → 波の割当: 既存ファイル編集を含む波（install/doctor/bin 配線、既存テスト更新）= codex_work（隔離 worktree）。独立新規ファイル生成の波（session-end.mjs 本体・spike ロガー・新規テストファイル）= composer も第一選択、統括が波ごとに選び理由を残す。
- **監査・発見**（02_models.md:36）:「`sonnet`×low・Workflow で明示」「中位=`gpt-5.6-terra`×medium・codex_auditor/explore」「`grok-4.5`・grok_agent / `grok -p`（並列 finder に好適）」
  → B-2 の保存構造棚卸しは grok 並列 finder + codex_explore の多角スイープ。
- **反証・検証**（02_models.md:37）:「主 継承×high・refuter」→ B-1 着手前 refuter・A 設計の追加反証に適用（model 省略=主継承が許されるのは検証・反証・裁定系のみ）。
- **裁定・契約クリティカル**（02_models.md:35）:「主 直轄（F）」→ schema v9・バトン上書き規則・捕捉契約変更・settings.json 操作・最終レビュー・コミット。着手前 refuter 1 回（ガードレール常時ON）。
- **オーナー実機操作 = H**（Desktop/VSCode での /clear 操作・最小再現）。

委譲は orchestrate スキル references/delegation-contract.md の 8 点セット（file:line 仕様・罠リスト・検証コマンド・合格条件・報告フォーマット・前提再検証義務）。委譲物は統括が diff レビュー + ゲート再実行してから採用。各 Workstream は独立に revert 可能な単位で刻み、波ごとに pathspec 明示コミット。エージェントに branch 切替・commit をさせない。

## Context

発端は「Claude Code Desktop の `/clear` で自動引き継ぎが発火しない」引き継ぎ書（Caveat: `claude-code-desktop-clear-sessionstart-source-startup-throughline`）。調査の過程で、発火しても**注入の中身が欠ける**別問題（L2 捕捉欠落）をオーナーの実機テストが炙り出した。オーナー裁定により両方を本スコープとする（2026-07-11）。

- **A: Desktop /clear 引き継ぎ発火** — Desktop は `source:"clear"` を送らない（VSCode 2.1.207 は送る。クライアント実装差で確定、バージョン交絡は棄却済み）。SessionEnd(reason='clear') バトン方式で解決する。
- **B: L2 捕捉の完全性** — 完了済み論理ターンの L2 欠落率: Desktop 27%・VSCode 41%（実会話の欠落例を目視確認済み）。二系統に分解:
  - **B-1（Throughline 側で直せる）**: transcript に本文はあるのに bodies に無い欠落。原因は turn-processor が各 Stop で「最後の 1 ペア」しか保存しない設計（[src/turn-processor.mjs](../src/turn-processor.mjs) の `getLastTurnPair` 単発保存）＝Stop 不発/空振りが永久穴になる。→ 全ターンスキャン・バックフィル型に再設計。
  - **B-2（原因未特定・CC/Desktop 側の可能性）**: Desktop で assistant 本文が transcript にそもそも書かれない/大幅遅延する。バグか仕様か未確定。最小再現で条件特定 → upstream 報告はその後に判断（オーナー承認制）。

## 調査で確定した事実（2026-07-11 実測・反証済み）

### 1. `/clear` はどのクライアントでも UserPromptSubmit hook に届かない

commit 75d79d7（2026-05-08「/clear writes baton」）は実運用ゼロ発火。決定的証拠は同一セッション内 /tl 対照実験 ×2:

- 2026-06-28 Novel（VSCode 2.1.195）: `/tl` 06:15:38 バトン書込 → 27 秒後 `/clear`。届いていれば trigger:"clear" で上書きされるはずが、後継が消費したバトンは `baton_age_ms:26777` ＝ /tl 時点のまま。
- 2026-07-11 Caveat（Desktop 2.1.205）: `/tl` 11:51:21 → `/clear` → 後継 65a01d22 の消費バトンは `baton_age_ms:35591` ＝同型。
- 2026-07-11 Throughline（VSCode **2.1.207**）: `/clear` 3 連発（13:15:46 / 13:16:18 / 13:16:54）でも baton-write.log に trigger:"clear" ゼロ（/tl の 1 件のみ）。最新版でも変わらず。

docs 整合: ビルトインコマンドは UserPromptSubmit（prompt 送信時）にも UserPromptExpansion（skill / custom command / mcp_prompt 展開時）にも乗らない。prompt-submit.mjs の /clear 分岐は無害な保険として残置。

### 2. VSCode と Desktop の /clear 挙動差（クライアント実装差で確定）

| クライアント | 実測バージョン | /clear の SessionStart | 検証方法 |
|---|---|---|---|
| VSCode (`entrypoint: claude-vscode`) | 2.1.195 / 2.1.199 / **2.1.207** | `source:"clear"` → auto path 発火・merged:true | inheritance-decision.log の source:"clear" 11+3 件、残存 transcript 8 件の entrypoint 実測 |
| Desktop (`entrypoint: claude-desktop`) | 2.1.205 | `source:"startup"`。旧/新どちらの transcript にも /clear 痕跡なし。**後継セッションは /clear 時でなく初回プロンプト送信時に生成**（65a01d22: SessionStart 11:51:56.968 → 初 user prompt 11:51:57.035、/clear はその 16 秒以上前） | 2026-07-11 の Desktop 実測ペア + 当日全 Desktop セッション |

バージョン交絡（2.1.200+ リグレッション説）は VSCode 2.1.207 実測で棄却。クライアント判別は hook から env `CLAUDE_CODE_ENTRYPOINT`（`claude-desktop` / `claude-vscode`）で可能。

### 3. 案A（startup 時間窓フォールバック）不採用の根拠

- 幽霊セッション: 2026-07-11 だけで project_path=/Users/kite の startup が **182 件**（03:02〜12:56、最短間隔 0.001 秒、全て bodies=0）。haiku-workdir に 207 件＝headless `claude -p` も SessionStart hook を発火する。
- 幽霊がチェーンに入ると MAX_CHAIN_DEPTH=10（[src/session-merger.mjs](../src/session-merger.mjs):14）へ数時間で到達し resolveMergeTarget throw → ターン捕捉が恒久停止＝ここで記憶が本当に失われる。
- source='startup' は「/clear の後継」と「並行して開いた別窓」を原理的に区別できず、稼働中セッションのレコードを relabel して記憶を split する。「bodies>0 の前任だけ選ぶ」は前任側フィルタなので無効（refuter 検証済み）。

### 4. SessionEnd hook 仕様（公式 docs live fetch 2026-07-11）

- SessionEnd は実在し、matcher が `reason` でフィルタ可能。reason enum: **`clear` / `resume` / `logout` / `prompt_input_exit` / `bypass_permissions_disabled` / `other`**。
- SessionStart source enum: `startup` / `resume` / `clear` / `compact`。
- **SessionEnd hook のデフォルト timeout は 1.5 秒**（/clear にも適用）→ per-hook timeout 明示が必須（サイレント kill によるバトン喪失対策）。
- Desktop が /clear 時に SessionEnd(reason='clear') を実際に発火するかは**未検証**（source を誤ラベルするクライアントなので要実測）→ A Phase 1 spike。

### 5. オーナーの 4 セッション連続 /clear テスト（2026-07-11 13:15-13:17, VSCode 2.1.207）

チェーン 4ef0d886 → c3e4e5d8 → ea60a1c9 → 9e74467d。マージは 3 回全部成功（auto ×2 + baton ×1）だが、**テスト全体で捕捉された L2 は 1 ターンのみ**（書込 13:16:45）。clear #1 (13:15:46)・#2 (13:16:18) の注入時点で DB は空 → 空の記憶を注入 → 体感「引き継げてない」で正解。3 回目の成功は /tl ではなく捕捉が追いついたため。state ファイルの 299 bytes（usage 無し＝[src/turn-processor.mjs](../src/turn-processor.mjs) の `!assistantTurn` 早期離脱痕跡）vs 397 bytes（フル実行）が Stop 空振りの証拠。

### 6. L2 捕捉欠落の全域調査（論理ターン単位・完了ターンのみ・haiku-workdir 除外）

| クライアント | セッション | 完了論理ターン | 未捕捉 | 率 |
|---|---|---|---|---|
| claude-desktop (2.1.205) | 13 | 133 | 36 | **27.1%** |
| claude-vscode (2.1.199-206) | 6 | 155 | 63 | **40.6%** |

- 論理ターン＝「user テキスト → 後続 assistant 断片群の最後の断片」。捕捉判定は bodies の (origin_session_id, turn_number=最終断片 index, role='assistant') 存在。
- VSCode 側の欠落は **transcript に本文が現存する**（調査自体が transcript から読めている）＝ Throughline 側の捕捉漏れ → B-1 で修正可能。
- 実在確認済みの欠落例: f1ad5b6f (WebAICoding) の実会話ターン #1/#3/#6 等。
- 注意: queued メッセージ（連続 user テキスト）が論理ターンを水増しする可能性は残る＝率は上限値の目安。

### 7. Desktop transcript の assistant 本文欠落（B-2・unconfirmed）

本調査セッション自身（d7650b10, Desktop 2.1.205）の実測: assistant エントリ 93 件の内訳 thinking 48 / tool_use 36 / **text 9**。12:44〜13:15 の長いターンには本文断片が約 8 個あったが、transcript に着地したのは 1 個だけ、しかも発話から**約 16 分遅れ**（13:12:48）。残りは transcript・プロジェクトディレクトリ・~/.claude 全域・Desktop の local-agent-mode-sessions のどこにも grep ヒットせず＝ローカル永久欠落。短いターン（13:17 以降）の本文は着地している。バグか仕様か（正本がサーバ/アプリ側にある可能性）は未確定。

---

## Phase 0 — 同期・安全網・正本化（憲法1/2）

- [x] git 同期状態の確認（origin/main と 0/0・stash なし・untracked `.agents/` は端末ローカル残置がオーナー裁定済み＝触らない）
- [x] ベースラインゲート green 確認: `npm test` 549 pass / 0 fail（2026-07-11）
- [x] 本プランを docs/12 として正本化（本文書）
- [x] rag/01-hooks に SessionEnd reason enum を還流（[session-end-reasons.md](../rag/01-hooks/raw/session-end-reasons.md)）、rag/INDEX.md に Finding 8 追記
- [x] 今日の調査を caveat に記録: public `claude-code-clear-userpromptsubmit-hook`（confirmed）/ private `claude-code-desktop-assistant-transcript-jsonl`（tentative・B-2 で更新）
- [x] 実稼働デプロイ（2026-07-12）: `npm i -g /Users/kite/Developer/Throughline`（symlink 化＝リポ変更が即時反映。リリース時は registry 版へ戻す）

## Workstream B-1 — 捕捉のバックフィル化（先行。A の E2E 品質の前提。挙動修正レーン＝挙動差を明文化して個別承認）

- [x] **B-1 設計の着手前 refuter**: 判定「目的は正当・原設計のままでは採用不可」。修正 7 件を採用: ①群レベル dedup 必須（部分捕捉済み群への再挿入は同一発話の重複ペアを 110 件量産——実在確認: d7650b10 turn14/15。割り込みは tool_result 内に埋まり user 境界として不可視のため 1 群複数 Stop が日常）②前任 transcript path は project_path から決定的導出（state は Stop 不発前任で存在しない）③junk 代表除外（session limit 通知等）④INSERT を 1 トランザクション ⑤created_at は transcript timestamp（now は一括回収で同一 ms に潰れ L2 窓・現在地アンカーの順序が tie で不定化）⑥readTranscript に isSidechain 防御 ⑦resume 直後 transcript の実測 1 回を検証項目に追加。棄却された懸念: 注入肥大化（20 ターンキャップで構造上起きない）・SessionStart レイテンシ（58MB transcript でも 155ms）
- [x] **turn-processor 再設計**: [src/turn-backfill.mjs](../src/turn-backfill.mjs) 新設（全論理ターン群走査 + 群レベル dedup + junk 除外 + timestamp created_at + 単一トランザクション）、turn-processor は毎 Stop でこれを呼ぶ。回収実績は `~/.throughline/logs/backfill.log`。機能検証済み: 実 transcript × 隔離 DB で回収 12 群・冪等（2 回目 0 挿入）・部分捕捉群の重複ガード・junk 0 行・created_at 順 = 会話順 【F: 統括直轄】
- [x] queued メッセージの扱いを明文化: 群 = 「user テキスト → 後続 assistant 断片群」なので、応答前に積まれた先行 queued user は断片 0 の群となり捕捉されない（現行 getLastTurnPair と同等の非対応。将来課題）
- [x] session-start のマージ直後にも同じバックフィルを前任 transcript に対して実行（project path からの決定的導出を優先し、state file は Stop 不発前任のため補助）→ 「/clear 直前ターンの取りこぼし」を注入前に回収。失敗は stderr + `backfill.log` に明示し、注入は継続
- [x] 診断ログ: バックフィルで回収したターン数を stderr ではなく `~/.throughline/logs/backfill.log` に記録（Stop / session-start 共通）
- [x] テスト: 全ターンスキャンの単体（群レベル dedup、冪等性、junk、timestamp、sidechain、path munging）と hook subprocess（multi-turn / state 無し前任）の特性化を追加。`npm test`: 559 pass / 0 fail（2026-07-12）
- [ ] 検証: 欠落率調査スクリプト（付録）を再実行し、新規セッションで欠落 0% を確認

## Workstream A — Desktop /clear 引き継ぎ発火（SessionEnd バトン方式）

### A Phase 1 — spike 実測（Desktop の SessionEnd 白黒判定）

- [x] spike ロガー hook（`spike/session-end-logger.mjs`）: stdin 全 payload + `CLAUDE_CODE_ENTRYPOINT` + 受信時刻を記録 【A → codex_work `gpt-5.6-terra`×medium で実装、統括が検証 3 本再実行済み。sidecar 側 PROTOCOL_ERROR（報告 envelope の schema 不一致）が出たが成果物は worktree から採用】
- [x] `~/.claude/settings.json` に SessionEnd を一時登録（絶対パス node + 絶対パス spike・timeout 10 明示。バックアップ: `~/.claude-settings-backup-20260711-235419.tar.gz`。撤去 = SessionEnd ブロック削除 + spike ファイル削除）【F: 統括直轄】
- [x] 実測プロトコル 【H: オーナー操作 2026-07-12 15:00-15:10 UTC】: ①Desktop /clear（③はアプリ終了の代わりにセッション削除で実施）②放置 ③削除 ④VSCode /clear。結果:

  | 操作 | SessionEnd 発火 | reason | 備考 |
  |---|---|---|---|
  | Desktop `/clear`（d93b0d5f） | **即時**（返答 15:05:52 → 15:05:59） | **`other`** | payload は session_id/prompt_id/reason/cwd/transcript_path のみ・判別子なし |
  | Desktop 放置（a8ece26f） | 発火せず | — | |
  | Desktop セッション削除（675493fb） | 発火（12 秒後） | **`other`** | payload 構造は /clear と完全同一 |
  | VSCode `/clear`（fa43271f） | 即時 | **`clear`** | 42ms 後に後継 SessionStart(source=clear)→auto merge。仕組み自体は健全 |

  副次発見: Desktop の幽霊セッション（/Users/kite）も SessionEnd(other) を高頻度で発火する。
- [x] 判定: **NO-GO**。Desktop は /clear で SessionEnd を即時発火するが reason を `other` にラベルし、**セッション削除（明示的破棄）と区別不能**。reason=other でバトンを書くと削除セッションの記憶が次セッションに蘇る誤注入 + 幽霊バトン汚染。reason 不問の退行案は不採用（計画どおり）。→ A Phase 2 は実装せず停止、fallback 裁定へ
- [x] spike 撤去: settings.json から SessionEnd 登録を削除（JSON 検証済み）、spike ファイル削除（git 履歴に残存）。実測ログ `~/.throughline/logs/session-end-spike.log` は証拠として保全

### A Phase 2 — 本実装（GO の場合のみ。refuter で出た穴 4 件の対策込み）

> **2026-07-12 NO-GO につき凍結**。Desktop が SessionEnd reason を正しくラベルする（または SessionStart source='clear' を送る）ようになった時点で解凍可。fallback は Phase 1 実測表とともにオーナー裁定: 案C（明文化 + /tl 運用）+ upstream 報告（証拠は二重: SessionStart source=startup 誤ラベル + SessionEnd reason=other 誤ラベル、VSCode 対照つき）。オーナー裁定 (2026-07-12): fallback 案C 採用・upstream 報告提出済み https://github.com/anthropics/claude-code/issues/76704 （修正が入れば auto path がそのまま Desktop で復活する）。

- [ ] schema v9: `handoff_batons.origin` 列（`'tl' | 'clear-prompt' | 'clear-session-end'`）【F: 統括直轄】
- [ ] バトン上書き規則: 明示 /tl は TTL 内なら自動バトンに上書きされない（明示意思 > 自動）。consumeBaton は origin を返し inheritance-decision.log に `baton_origin` 記録 【F: 統括直轄】
- [ ] `src/session-end.mjs` 新設: reason==='clear' かつ `THROUGHLINE_DISABLE_AUTO_HANDOFF !== '1'` で writeBaton。全イベントを session-end.log に記録。import-safe run() 型 【A: 実装物量 → 02_models.md:40】
- [ ] bin dispatch / install.mjs SC_HOOKS 追加（**per-hook timeout 明示** — 既定 1.5 秒 kill 対策）/ uninstall / doctor 表示 【A: 実装物量 → 02_models.md:40】
- [ ] テスト: baton origin 規則・session-end subprocess・db-schema v9・install 冪等 【A: 実装物量 → 02_models.md:40 → 統括 diff レビュー + ゲート再実行】
- [ ] TTL は /tl と同じ 1 時間（一貫性優先。短縮代替案: clear 由来のみ 5〜10 分に絞る案があったが、Desktop は後継生成が初回プロンプト時なので取りこぼしリスクと引き換え＝不採用の記録）

### A Phase 3 — E2E・後始末

- [x] spike hook 撤去（settings.json 復元確認）
- [ ] E2E: Desktop 実機で `/tl` → `/clear` → 新セッションの注入本文が直前ターンを含むこと + `backfill.log` の session-start 行を確認
- [x] `npm test` 全緑、CLAUDE.md / README / docs 更新、caveat_update で `claude-code-desktop-clear-sessionstart-source-startup-throughline` の resolution 更新（2026-07-12 更新済み）

## Workstream B-2 — Desktop transcript 本文欠落の条件特定（調査のみ。実装なし）

- 2026-07-12 追試 — 本調査セッション自身で欠落が継続再現（15:20 以降の本文 ~8 個中 5 個のみ着地・中間分析テキストが欠落）。短ターン（オーナーのテストセッション 4 本）は全て着地 → 「長い tool 連発ターンで欠ける」仮説と整合。保存構造棚卸しは Claude レーンで実行中（会話実データを外部枠に流さないプライバシー優先の逸脱 — 02_models.md:36 の既定から明示逸脱）。
- [ ] 最小再現: 新しい Desktop セッションで短い会話 → transcript の assistant text エントリ有無を即時/遅延で確認。plan モード・大量 tool use・長ターンの条件差を分ける 【H: オーナー操作 + 統括分析】
- [ ] local-agent-mode の保存構造を read-only で棚卸し（正本がローカル JSONL 以外にあるか）【A: 監査・発見 → 02_models.md:36 = `grok-4.5` 並列 finder（grok_agent / `grok -p`）+ Codex 中位 `gpt-5.6-terra`×medium（codex_explore）の多角スイープ】
- [ ] 結論を caveat / 本文書に記録。**upstream 報告はここで確証が取れた場合にドラフトを見せて承認後に提出**（バグと断定できなければ報告しない）

## 実装しないこと

- 案A startup 時間窓フォールバック / reason 不問バトン / prompt-submit の /clear 分岐削除（無害残置）
- B-2 の「修正」実装（原因が CC 側なら Throughline では直せない。B-1 のバックフィルが Throughline 側でできる最大限）

## 検証コマンド

```bash
npm test
node bin/throughline.mjs doctor
tail -f ~/.throughline/logs/session-end-spike.log      # A Phase 1
tail -f ~/.throughline/logs/inheritance-decision.log   # A Phase 3 (baton_origin)
```

## 付録 — 欠落率調査スクリプト（B-1 検証用・read-only）

```javascript
// node --input-type=module < この内容 （リポジトリルートで実行）
import { getDb } from './src/db.mjs';
import { readTranscript } from './src/transcript-reader.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const db = getDb();
const sessions = db.prepare(`
  SELECT session_id, project_path FROM sessions
  WHERE merged_into IS NULL AND session_id NOT LIKE 'codex:%'
  ORDER BY updated_at DESC LIMIT 300
`).all();
const projRoot = join(homedir(), '.claude', 'projects');
const tPath = (p, sid) => {
  const f = join(projRoot, p.replace(/[\/.]/g, '-').replace(/^-?/, '-'), sid + '.jsonl');
  return existsSync(f) ? f : null;
};
const logicalTurns = (turns) => {
  const r = []; let cur = null;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role === 'user') { if (cur) r.push(cur); cur = { lastAsstIdx: -1 }; }
    else if (turns[i].role === 'assistant' && cur) cur.lastAsstIdx = i;
  }
  if (cur) r.push(cur);
  return r.filter(lt => lt.lastAsstIdx >= 0);
};
const byClient = {};
for (const s of sessions) {
  if (s.project_path.includes('haiku-workdir')) continue; // 再帰ガードで捕捉しない設計
  const tp = tPath(s.project_path, s.session_id);
  if (!tp) continue;
  const lts = logicalTurns(readTranscript(tp));
  if (lts.length < 2) continue;
  let ep = null;
  for (const line of readFileSync(tp, 'utf8').split('\n')) {
    try { const e = JSON.parse(line); if (e.entrypoint) { ep = e.entrypoint; break; } } catch {}
  }
  if (!ep) continue;
  const cap = new Set(db.prepare(
    `SELECT turn_number FROM bodies WHERE origin_session_id = ? AND role = 'assistant'`
  ).all(s.session_id).map(r => r.turn_number));
  const scanned = lts.slice(0, -1); // 最終ターンは進行中の可能性 → 除外
  const miss = scanned.filter(lt => !cap.has(lt.lastAsstIdx)).length;
  byClient[ep] ??= { sessions: 0, turns: 0, missing: 0 };
  byClient[ep].sessions++; byClient[ep].turns += scanned.length; byClient[ep].missing += miss;
}
for (const [k, v] of Object.entries(byClient))
  console.log(k, v, `${(100 * v.missing / v.turns).toFixed(1)}%`);
```
