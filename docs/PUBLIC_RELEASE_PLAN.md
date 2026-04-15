# Throughline 公開配布化プラン

## §0 プロジェクト不変ルール

**フォールバック / 逃げ道のコードを書かない。** バグを隠してデバッグを困難にするため、想定外の状態・契約違反・依存関係の不在などに遭遇した場合は **エラーを吐いて停止** する。該当箇所を後で直すのが正しい対応。

具体的には以下のパターンを禁止する:

- `try { ... } catch { /* ignore */ }`（例外を黙って握り潰す）
- `catch (err) { stderr.write(...); process.exit(0); }`（エラーを記録しつつ成功コードで終わる）
- 「A がダメなら B」という暗黙の切り替え（明示的な設定フラグなしでの挙動分岐）
- 未検証の契約に対する「とりあえず動く」実装

例外は以下のみ:
- 外部入力のバリデーション失敗 → 明確な `throw new Error(...)` で拒否
- hook 実行での I/O エラー → stderr + 非ゼロ終了コード（Claude Code 側で可視化される）
- 既に値が NULL であることが設計上許容されている場合の `?.` アクセス

この原則は §8 のコード掃除タスクで既存コードにも適用する。

## Context

Throughline を GitHub で公開して世界中の Claude Code ユーザーに使ってもらいたい。満たすべき条件:

1. **導入が簡単** — 1〜2 コマンドで完了
2. **複数プロジェクトで動く** — 導入後は全プロジェクトで自動的に働く
3. **絶対パス依存を避ける** — 環境差（Windows / macOS / Linux、node のインストール先）で壊れない

現状の障害は 1 点だけ:
- [install.mjs](../install.mjs) が `.claude/settings.json`（プロジェクトローカル）に `node src/detail-capture.mjs` のような **相対パス** で hook を書き込んでいる。
- 他プロジェクトで Claude Code を起動すると CWD が変わり、`src/detail-capture.mjs` が見つからず全 hook が即エラーになる。

一方で、コア側はすでに移植性が高い:
- [context-injector.mjs:108](../src/context-injector.mjs#L108) は `payload.cwd`（hook stdin）でプロジェクトを識別 → CWD 非依存
- [db.mjs:10-11](../src/db.mjs#L10-L11) は `~/.throughline/throughline.db` を使う → ユーザー単位で共有、プロジェクト単位で `sessions.project_path` により論理分離
- [detail-capture.mjs:105](../src/detail-capture.mjs#L105) だけ `process.cwd()` を使っているが、これは Claude Code 起動時の CWD = プロジェクトルートなので現状動作する（統一のため payload.cwd に変更する）

## 結論: npm グローバル + bin エントリ 方式

### 導入フロー（ユーザー視点）

```bash
npm install -g throughline     # CLI を PATH に配置
throughline install            # ~/.claude/settings.json に hook を追記
```

これだけで全プロジェクトに自動適用される。絶対パスは一切書かない。hook コマンドは **`throughline capture-tool` のような PATH 解決型** にするので、node のインストール先や OS が変わっても PATH さえ通っていれば動く。

### なぜこれが条件を満たすか

| 条件 | 達成方法 |
|------|---------|
| 導入が簡単 | `npm i -g` + `throughline install` の 2 コマンド |
| 複数プロジェクトで動く | `~/.claude/settings.json`（ユーザースコープ）に hook を登録 → 全プロジェクトで自動発火 |
| 絶対パス非依存 | hook コマンドは `throughline <subcommand>` のみ。PATH 上にある限り OS / node バージョンが変わっても追従 |

### 却下した代替案

- **npx (`npx -y throughline capture-tool`)**: インストール不要だが、hook 発火ごとに npx のオーバーヘッドが乗る。`PostToolUse` は 1 ターンに数回呼ばれるので UX が悪化する。初回セットアップ (`npx throughline install`) だけ npx 経由を許容し、実行時は global bin を使う。
- **絶対パスを install 時に解決** (`node C:\Users\...\src\...`): install.mjs 内で `__dirname` を使って書けば動くが、リポジトリを移動すると壊れる。npm 管理に任せる方が安全。
- **Claude Code プラグイン形式**: 魅力的だがプラグインマーケットプレース経由の制約が多い。まず npm で出して、将来 ECC などに登録する。

---

## 実装ステップ

> **進捗 (2026-04-15)**: §1 / §2 / §3 / §4 / §4.4 / §4.5 / §4.6 / §5 / §8 実装完了。§6 README 更新完了、LICENSE は既に存在 (MIT)。残タスクは §7（`npm pack --dry-run` 検証 + npm link E2E 検証）のみ。

### 1. CLI エントリポイント追加 ✅ 実装済み ([bin/throughline.mjs](../bin/throughline.mjs))

**新規ファイル**: `bin/throughline.mjs`

```javascript
#!/usr/bin/env node
// 単一ディスパッチャ。サブコマンドに応じて既存の hook スクリプトへ委譲する。
const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case 'install':        await (await import('../src/cli/install.mjs')).run(rest); break;
  case 'uninstall':      await (await import('../src/cli/install.mjs')).run(['--uninstall', ...rest]); break;
  case 'capture-tool':   await import('../src/detail-capture.mjs'); break;
  case 'process-turn':   await import('../src/turn-processor.mjs'); break;
  case 'inject-context': await import('../src/context-injector.mjs'); break;
  case 'session-start':  await import('../src/session-start.mjs'); break;
  case 'monitor':        await import('../src/token-monitor.mjs'); break;
  case 'doctor':         await (await import('../src/cli/doctor.mjs')).run(); break;
  case 'status':         await (await import('../src/cli/status.mjs')).run(); break;
  case '--version':      console.log((await import('../package.json', { assert: { type: 'json' } })).default.version); break;
  default:               showHelp();
}
```

### 2. package.json を配布用に整備 ✅ 実装済み

```json
{
  "name": "throughline",
  "version": "0.1.0",
  "type": "module",
  "bin": { "throughline": "./bin/throughline.mjs" },
  "files": ["bin/", "src/", "README.md", "LICENSE"],
  "engines": { "node": ">=22.5" },
  "description": "Claude Code hooks plugin for structured context compression (/clear-safe persistent memory)",
  "keywords": ["claude-code", "hooks", "context-compression", "llm"],
  "repository": { "type": "git", "url": "https://github.com/kitepon-rgb/Throughline" },
  "license": "MIT",
  "author": "kitepon"
}
```

`files` でホワイトリスト指定して tarball を軽量化する。`spike/`, `docs/`, `.claude/` は除外。

### 3. install コマンドを書き直す ✅ 実装済み ([src/cli/install.mjs](../src/cli/install.mjs))

**対象**: 既存の [install.mjs](../install.mjs) を `src/cli/install.mjs` に移動して作り直す。

変更点:
- デフォルトで **`~/.claude/settings.json`（グローバル）** を対象にする
- オプション `--project` でプロジェクトローカル `.claude/settings.json` を対象にする（従来互換）
- 書き込む hook コマンドは相対 `node src/...` ではなく **`throughline capture-tool` / `process-turn` / `inject-context` / `session-start`**
- 既存 `hooks` セクションを保持（マージ）する挙動は現 install.mjs から流用
- `writeSettings` は JSON のインデントとキー順を既存ファイルから継承する（他プラグインと共存しやすく）

hook 登録後の `~/.claude/settings.json`（抜粋）:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "throughline session-start" }] }
    ],
    "PostToolUse": [
      { "matcher": "Bash|Write|Edit|Read|Grep|Glob",
        "hooks": [{ "type": "command", "command": "throughline capture-tool" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "throughline process-turn" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "throughline inject-context" }] }
    ]
  }
}
```

### 4. detail-capture を payload.cwd 対応に

[detail-capture.mjs:105](../src/detail-capture.mjs#L105) の `process.cwd()` を `payload.cwd ?? process.cwd()` に変更。グローバル hook 化後も project_path が正しくプロジェクトディレクトリになる保険。

### 4.4. `/clear` 跨ぎの記憶継承 — **Phase 2.5 記憶張り替え方式で実装完了 (2026-04-15)**

> **現状**: 本節の元設計（parent_pid + predecessor_session_id + 再帰禁止）は破棄され、**記憶張り替え方式** (merged_into + origin_session_id, schema v3) に置き換え済み。実装詳細は `C:\Users\kite_\.claude\plans\curious-cooking-pumpkin.md` および [CLAUDE.md](../CLAUDE.md) の「Phase 2.5」節を参照。以下は歴史記述として残す。
>
> **実装実態の要点**:
> - SessionStart hook が前任の skeletons/judgments/details の session_id を新セッションに **UPDATE (張り替え)** する。origin_session_id には前任 session_id が保持され、系譜を記録
> - 前任選択は同 project_path で merged_into IS NULL の最新 updated_at（ppid は使わない — 実機検証で不成立が確定）
> - 時間窓ハード制限なし。冒頭ヘッダで引き継ぎ件数と前任 session_id を可視化
> - 複数 /clear を跨いで origin 別に記憶がチェーン蓄積 (Case B 検証済み)
> - 並行セッション時は注意書きをヘッダに明示
>
> 元設計のうち生き残った概念: 「バナー冒頭表示で継承の有無を二値信号化する」「再帰 walk しない」「時間窓ハード制限を撤廃」。

<details>
<summary>元設計（破棄済み、参考）</summary>

**問題**: 現在の [context-injector.mjs:42-50](../src/context-injector.mjs#L42-L50) のフォールバックは「同 `project_path` で `updated_at` 最新の他セッション」という条件だけで復元先を選ぶ。以下 2 つのケースで誤注入が起きる:

1. **並行セッションの汚染**: 同一プロジェクトで 2 つ以上のセッションが並行実行中に片方が `/clear` すると、もう一方のセッションの記憶を誤って拾う
2. **CC 再起動後の別話題**: ユーザーが CC を終了 → 新しく `claude` を起動して全く別の話題 → 直近 1 時間以内に前セッションがあれば無関係の記憶が混入する

**根本解決**: `SessionStart` hook を導入し、**新セッションが生まれた瞬間に「どの親から来たか」を決定的に記録する**。ヒューリスティック推測を UserPromptSubmit から完全に排除する。

#### DB スキーマ v3

```sql
ALTER TABLE sessions ADD COLUMN parent_pid INTEGER;
ALTER TABLE sessions ADD COLUMN source TEXT;                 -- 'startup' | 'resume' | 'clear' 等
ALTER TABLE sessions ADD COLUMN predecessor_session_id TEXT; -- source='clear' のときだけ設定
```

#### 基本方針: SessionStart 直接注入 + 透過的バナー（案 A+）

`/clear` 発生の瞬間に、新セッションのコンテキストへ predecessor の記憶を直接注入する。ユーザー発言を待たないので UX が最良。

設計原則:
1. **常にバナーを冒頭に付け、継承元・経過時間・逃げ道を明示する**
2. **predecessor 候補は「直前の ppid 一致セッション」に限定し、再帰で祖先まで辿らない**（/clear 連打での escape を可能にする）
3. **gap が長いときは警告バナーに変える**（ハード制限ではなく、ユーザー判断に委ねる）
4. **ハードな 1 時間制限は撤廃する**（バナー表示により代替される）

バナーの有無が「引き継ぎの有無」を可視化する二値信号になる:
- バナーあり → 前セッションの記憶を継承した（ユーザーが目視で確認できる）
- バナーなし → 完全な新規セッション（クリーンだと確信できる）

#### SessionStart (`src/session-start.mjs`) の動作

- 登録コマンド: `throughline session-start`
- 動作:
  1. stdin から `{session_id, source, cwd, transcript_path}` を取得
  2. `process.ppid` を取得
  3. `sessions` テーブルに `(session_id, project_path, parent_pid, source, created_at, updated_at)` を INSERT
  4. `source === 'clear'` でなければ即 return（`startup` / `resume` / その他は何もしない）
  5. predecessor 候補を以下条件で検索:
     - 同 `project_path`
     - 同 `parent_pid`
     - `ORDER BY updated_at DESC LIMIT 1`
  6. **候補が skeletons を持っているか確認**。持っていなければ `predecessor_session_id = NULL` のまま return（継承なし）。これにより /clear 連打で逃げる動作が成立する（**再帰 walk しないのが肝**）
  7. 持っていれば `predecessor_session_id` に記録
  8. predecessor の L1/L2 を整形し、**バナー + 本体** を stdout に生テキストで書き出す

#### 注入フォーマット（通常）

```
## Throughline: 前セッションの記憶を引き継ぎました

  前セッション: <short session_id>
  最終活動: <時刻> (<経過時間>)
  引き継ぎ: L1=<turns> ターン / L2=<items> 項目
  意図しない継承なら /clear を再実行してください。

### 判断・制約・未解決事項 (L2)
[DECISION] ...
[CONSTRAINT] ...

### 直近のターン履歴 (L1)
turn 1 [assistant]: ...
turn 2 [user]: ...
...
```

gap が 6 時間超のときはバナーを強調表示:

```
## Throughline: 前セッションの記憶を引き継ぎました ⚠ 長期ブランク

  前セッション: <short session_id>
  最終活動: 昨日 15:00 (約 23 時間前)
  長期ブランクからの継承です。違う話題で始めた場合は /clear 推奨。
  ...
```

#### UserPromptSubmit (`context-injector.mjs`) の新ロジック

predecessor 関連のロジックを完全撤去し、自セッションのリフレッシュだけを担当する:

```javascript
function buildContext(currentSessionId) {
  if (!currentHasSkeletons(currentSessionId)) return null;
  return fetchData(currentSessionId);
}
```

SessionStart で一度バナー付き注入が終わっているので、UserPromptSubmit は「現セッションの自前 L1/L2 を毎ターン最新化する」だけの役割になる。

#### ケース表（最終形）

| シナリオ | SessionStart 動作 | 結果 |
|---------|-------------------|------|
| 通常ターン | — (fire しない) | UserPromptSubmit 経由で自前注入 ✅ |
| `/clear` → 発言継続 | pred=A を記録、バナー付き注入 | A の記憶（通常バナー） ✅ |
| `/clear` → 見て違うと判断 → 再 `/clear` | 直前 pred=A' (skeletons なし) → pred=NULL | 継承なし ✅ |
| `/clear` 放置 → 翌日続行 | yesterday 15:00 に注入済、バナーで長期警告表示 | ユーザー判断 ✅ |
| `/clear` 放置 → 翌日 `/clear` | 直前 pred=A' (skeletons なし) → pred=NULL | 継承なし ✅ |
| `/clear` → 発言 → `/clear` | 直前 pred=A' (skeletons あり) → A' 注入 | 期待通り ✅ |
| CC 終了 → 新 `claude` で別話題 | source='startup' | 継承なし ✅ |
| 並行 CC × 2、片方 `/clear` | 同 ppid の前任のみ | 汚染なし ✅ |
| CC クラッシュ → 再起動 | source='startup' | 手動復旧（将来拡張） |

#### なぜ再帰 walk をやめたか

「skeletons を持つ最も近い祖先まで辿る」再帰ルールは、/clear 連打で逃げようとしているユーザーの意図を妨げる:

```
A (skeletons) → /clear → A' (empty, 注入されたが不要) → /clear → A''
                                                            ↓
                                          再帰 walk で A を再注入 ❌
```

再帰を削ることで「/clear で逃げる」という UX を成立させる。発言なしでの連打による祖先復元はレアケースとして諦める。

#### スパイク必須: SessionStart 注入の動作確認

SessionStart hook の stdout が実際に新セッションのコンテキストに注入されるかは未確認。**実装前に `spike/test-session-start.mjs` で以下を確認**:

1. SessionStart hook は `source` / `session_id` / `cwd` / `transcript_path` を stdin に渡してくるか
2. `source` フィールドの正確な値 (`startup` / `resume` / `clear` 等)
3. stdout の生テキストが新セッションの初期コンテキストとして可視化されるか
4. `{"additionalContext": "..."}` の JSON 形式が必要か、生テキストで足りるか
5. SessionStart と UserPromptSubmit の発火順序保証

**スパイクで期待通り動かなかった場合**: fallback を書かずに **いったん作業を止めて計画を見直す**（§0 プロジェクトルール参照）。

</details>

### 4.5 / 4.6 の設計判断履歴 (2026-04-15 更新)

以下は token-monitor 改良の設計判断を確定したもの。本節以降の §4.5 / §4.6 の記述はこの判断に従って読むこと。

- **ファイル監視方式**: `fs.watch` ではなく **`setInterval` (1s) + `readdirSync` + mtime 差分検知**。Windows での atomic-write / rename イベント取りこぼし回避のため
- **「自分のセッション」識別**: **状態ファイルの `updatedAt` 降順ソート、先頭行をハイライト**。`context-injector` (UserPromptSubmit) に加えて **`turn-processor` (Stop hook) でも updatedAt を更新** して、アシスタント応答終了時も追従する
- **stale 判定**: **PID 生存チェック** (`process.kill(pid, 0)` で ESRCH なら死)。状態ファイルに hook 実行時の `process.pid` を含めて書く。時間窓は廃止（旧プランの「1 時間」はアシスタントの自作指定であり、ユーザー承認なし）
- **トークンカウント再計算コスト**: 差分読み (mtime + byte offset) キャッシュ。transcriptPath の JSONL を前回読んだ位置から末尾までだけ読む
- **トークンカウント方式の刷新 (案 2 確定)**: 現行の `length/4` ヒューリスティックを捨て、**transcript JSONL の最新 assistant エントリの `message.usage` フィールドから `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` を直接読む**。これは Anthropic API の実測値であり、length/4 より劇的に正確
  - 調査結果: claude-hud は Claude Code のステータスライン stdin (`context_window.current_usage` + `rate_limits`) を受け取るだけで計算していない。Throughline monitor は独立 CLI のため stdin は届かず、単純移植は不可能
  - ただし Claude Code 本体が JSONL に assistant エントリを書くとき、各エントリの `message.usage` に公式トークン数が入っている。monitor はこれを読む
  - `context_window_size` は JSONL に無いので **`message.model` 名から推論** (例: `claude-opus-4-6[1m]` → 1_000_000, `claude-sonnet-4-6` → 200_000)。デフォルトは 200_000
  - 差分読みキャッシュ: 末尾 byte offset から新規行だけ読み、最新の `message.usage` を抽出してキャッシュ更新
- **Usage / Weekly 表示は不採用**: claude-hud の `rate_limits` (5h / 7d) はステータスライン stdin 専用で、JSONL にも Anthropic 公開 API にも無い。独立 monitor から取得不可のため機能追加は見送り。ユーザーは既に claude-hud を設定済みで、Throughline monitor はマルチセッションのトークン状況表示に特化する (claude-hud と機能重複を避ける)

### 4.5. 状態ファイルをセッション単位に分割（クロスプロジェクト分離） ✅ 実装済み ([src/state-file.mjs](../src/state-file.mjs), 2026-04-15)

**問題**: 現状は `~/.throughline/current-state.json` の **単一ファイル last-writer-wins** で、複数プロジェクト並行実行時に token-monitor が直前に発話したプロジェクトに追従してしまう。同一プロジェクト内で複数セッションが並行している場合も区別できない。

**解決**: 状態ファイルをセッション ID ごとに分割する。

- **パス**: `~/.throughline/state/<session_id>.json`
- **中身**:
  ```json
  {
    "sessionId": "abc1234...",
    "projectPath": "C:/Users/kite_/Documents/Program/Throughline",
    "transcriptPath": "...",
    "pid": 12345,
    "updatedAt": 1728998400000
  }
  ```
- **書き手の拡張**: `context-injector` (UserPromptSubmit) と `turn-processor` (Stop hook) の両方で書き換える。アシスタント応答終了時も updatedAt を最新化し、monitor 側の「アクティブ判定」が応答中も追従できるようにする
- **書き手**: `context-injector.mjs` が自分の session_id のファイルだけを書き換える → 書き込み競合ゼロ
- **stale 判定**: 状態ファイルに書かれた `pid` を `process.kill(pid, 0)` で生存確認し、ESRCH なら stale として削除（時間窓は使わない、§4.5/4.6 設計判断参照）
- **projectPath 正規化**: 書き込み時にも読み取り時にも **同じ正規化関数** を通す。正規化ルール = `path.resolve()` で絶対化 → バックスラッシュをスラッシュに統一 → 末尾スラッシュ除去 → Windows では lower-case
- **既存レコードの扱い**: 公開前なので開発中の古い `project_path` レコードは **見捨てる**（マイグレーションしない）

**対象ファイル**:
- [context-injector.mjs:17](../src/context-injector.mjs#L17) の `STATE_FILE` 定義と書き込みロジック
- `src/token-monitor.mjs` の読み取り側全面書き換え（下記 §4.6）

### 4.6. token-monitor をマルチセッション対応に ✅ 実装済み ([src/token-monitor.mjs](../src/token-monitor.mjs), [src/transcript-usage.mjs](../src/transcript-usage.mjs), 2026-04-15)

**デフォルト動作の変更**:
- 現状: 単一の current-state.json を読み、1 本の進捗バーを表示
- 新設計: `~/.throughline/state/*.json` を全て読み、**現在の CWD に一致する projectPath のセッション全てを 1 行ずつ並べて表示**

**CLI**:

| コマンド | 動作 |
|---------|------|
| `throughline monitor` | `process.cwd()` に一致する全 active セッションを表示（デフォルト） |
| `throughline monitor --all` | 全プロジェクト全セッション |
| `throughline monitor --session <id>` | 特定セッションのみ |

**表示例（同一プロジェクト 2 セッション）**:
```
[Throughline] Throughline  abc1234  ████░░░░░░  45k / 22%  残 155k
[Throughline] Throughline  def5678  ██████░░░░  89k / 44%  残 111k  ⚠ /clear 推奨
```

**実装ポイント**:
- **ファイル監視**: `setInterval(1000)` で `readdirSync(STATE_DIR)` → 各ファイルの mtime をキャッシュと比較して差分検知（`fs.watch` は Windows で不安定なので不採用）
- **アクティブ行のハイライト**: 全セッションを `updatedAt` 降順ソートし、先頭行に `▶` マーク等を付与
- **トークン数計算**: transcript JSONL の最新 assistant エントリの `message.usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens` を読む。差分読みで末尾 byte offset 〜 現在末尾のみパースし、最後に見つかった usage 値をキャッシュして表示
- **描画**: ANSI カーソル制御（`\x1b[{n}F` で n 行戻る、`\x1b[2K` で行クリア）で該当行だけ in-place 更新
- **stale 行**: `process.kill(pid, 0)` で ESRCH を捕捉したセッションは状態ファイル削除 + 表示から除去
- **SIGINT**: grace stop（`\x1b[?25h` でカーソル復帰）
- **Usage / Weekly 表示**: 不採用 (上記 §4.5/4.6 設計判断履歴の通り、rate_limits は独立 CLI からは取得できない)

**対象ファイル**: `src/token-monitor.mjs` をほぼ全面書き換え

### 5. doctor サブコマンド追加 ✅ 実装済み ([src/cli/doctor.mjs](../src/cli/doctor.mjs))

**新規ファイル**: `src/cli/doctor.mjs`

チェック項目:
- Node.js バージョン `>= 22.5`
- `~/.claude/settings.json` に Throughline hook が登録されているか
- `~/.throughline/throughline.db` が書き込み可能か
- `node:sqlite` がロードできるか（Node ビルドにより稀に無効）
- 各サブコマンドが PATH から解決できるか（`which throughline` 相当）

ユーザーが「動かない」と言ってきたとき、最初に `throughline doctor` を叩いてもらえる状態にする。

### 6. README と LICENSE を用意

- `README.md`: Quick Start（`npm i -g` → `throughline install`）、コンセプト 3 層モデル、トラブルシュート、`--project` モードの説明
- `LICENSE`: MIT
- `docs/CONCEPT.md` は既存のものを流用

### 7. npm publish 準備

- `npm pack --dry-run` で tarball 内容を確認
- `throughline` 名が npm で空いているか確認（空いていなければ `@kitepon/throughline` などスコープ付きに変更）
- GitHub Actions で `release` タグ push 時に自動 publish する CI を後で足す（Phase 3 スコープ）

### 8. 既存の silent try/catch を掃除（§0 ルール適用）

既存の hook スクリプトには「エラーを握り潰す」パターンがあり §0 ルールに違反する。公開前に掃除する。

**対象パターン**:

- [detail-capture.mjs:62-64](../src/detail-capture.mjs#L62-L64): JSON parse 失敗時に `stderr + exit(0)` → 無音成功
- [detail-capture.mjs:69-72](../src/detail-capture.mjs#L69-L72): session_id 欠落時に `stderr + exit(0)` → 無音成功
- [detail-capture.mjs:88-90](../src/detail-capture.mjs#L88-L90): token estimation エラーを catch で吸収
- [detail-capture.mjs:115-117](../src/detail-capture.mjs#L115-L117): DB エラーを catch で吸収
- [detail-capture.mjs:122-125](../src/detail-capture.mjs#L122-L125): 未捕捉エラーを exit(0) で隠す
- [context-injector.mjs:107](../src/context-injector.mjs#L107): `try { payload = JSON.parse(raw || '{}'); } catch { /* ignore */ }`
- [context-injector.mjs:119](../src/context-injector.mjs#L119): state ファイル書き込みエラーを `catch { /* ignore */ }`
- [context-injector.mjs:131-133](../src/context-injector.mjs#L131-L133): buildContext エラーを stderr で流すだけ

**掃除方針**: JSON parse 失敗・必須フィールド欠落・DB エラー・token 推定エラー・state ファイル I/O エラー → 全て `throw` で落とす。hook の非ゼロ終了は Claude Code の stderr 表示で可視化される。

---

## 変更する主要ファイル

| ファイル | 種別 | 内容 |
|----------|-----|------|
| `package.json` | ✅ 実装済み | `bin`, `files`, `description`, `repository`, `license`, `keywords` |
| `bin/throughline.mjs` | ✅ 実装済み | CLI ディスパッチャ |
| `src/cli/install.mjs` | ✅ 実装済み | グローバル対応、`--project` 互換 |
| `src/cli/doctor.mjs` | ✅ 実装済み | 診断コマンド |
| `src/cli/status.mjs` | ✅ 実装済み | DB 統計表示 |
| `src/detail-capture.mjs` | 未着手 | `process.cwd()` → `payload.cwd ?? process.cwd()` |
| `src/session-start.mjs` | ✅ 実装済み | SessionStart hook 本体。前任 skeletons/judgments/details を新 session_id に張り替え + 引き継ぎヘッダ注入 |
| `src/session-merger.mjs` | ✅ 実装済み | `resolveMergeTarget` / `mergePredecessorInto`（BEGIN IMMEDIATE トランザクション） |
| `src/resume-context.mjs` | ✅ 実装済み | L1+L2 レンダリング共有モジュール |
| `src/db.mjs` | ✅ 実装済み | schema v3: `skeletons/judgments/details.origin_session_id`, `sessions.merged_into` 追加、UNIQUE 制約 (session_id, origin_session_id, turn_number, role) |
| `src/context-injector.mjs` | 一部変更 | resolveMergeTarget で合流後追従 ✅。STATE_FILE セッション単位分割 + stale sweep (§4.5) — 未着手 |
| `src/token-monitor.mjs` | 全面書き換え | マルチセッション表示、CWD 絞り込み、`--all`/`--session` フラグ |
| `install.mjs`（旧） | 削除 | `throughline install` に統合 |
| `README.md` | 新規 | 公開用 Quick Start |
| `LICENSE` | 新規 | MIT |

## 流用する既存実装

- [install.mjs:48-105](../install.mjs#L48-L105): hook マージ・冪等化ロジック → `src/cli/install.mjs` にそのまま移植
- [context-injector.mjs:108](../src/context-injector.mjs#L108): `payload.cwd` によるプロジェクト特定 → detail-capture にも同パターンを適用
- [db.mjs:10-11](../src/db.mjs#L10-L11): `~/.throughline/` 配置 → そのまま

---

## 検証方法（End-to-End）

1. ローカルで `npm link` して CLI を PATH に通す
   ```bash
   cd Throughline
   npm link
   throughline --version
   ```

2. 自プロジェクト以外のディレクトリに移動
   ```bash
   mkdir ~/tmp-test-project && cd ~/tmp-test-project
   ```

3. `throughline install` で `~/.claude/settings.json` に hook が書かれていることを確認

4. そのディレクトリで `claude` を起動し、1〜2 ターン会話
   - 全 hook がエラーなく発火するか確認
   - `/clear` 後に SessionStart バナーが表示されるか確認
   - バナーなしの新規 `claude` 起動で汚染がないことを確認

5. DB を直接確認: `project_path` が正しいディレクトリになっていること

6. `throughline doctor` で全チェックが緑になるか

7. `throughline uninstall` で Throughline 行だけがクリーンに消えること

8. `npm pack --dry-run` で秘密情報・不要ファイルが含まれていないか確認

---

## スコープ外（別 Phase）

- npm への実 publish
- GitHub Actions による自動リリース
- `/sc-detail <turn>` スラッシュコマンド（Phase 2 残タスク）
- `injection_log` 効果測定（Phase 2 残タスク）
- Claude Code プラグインマーケットプレース（ECC 等）登録（Phase 3+）
