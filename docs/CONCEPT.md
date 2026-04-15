# Throughline — 構造化記憶による会話履歴最適化

> Claude Codeのコンテキスト肥大化を「捨てずに構造化」で解決するhooksプラグイン。
> SmartClaudeの実データ（$4,211/月相当の利用分析）に基づいて設計。

**設計思想：セッション内完結。目的はコンテキスト削減によるコスト削減のみ。**
永続的な知識資産の構築や、セッション横断の記憶管理は本プラグインのスコープ外とする。

## 背景・課題

SmartClaudeの分析により判明した事実：

- **1ターンあたり平均188Kトークン**消費
- そのうち**履歴が164K（87%）**を占める
- CLAUDE.md（12.7K）やMCP（3.9K）の最適化では根本解決にならない
- 既存の `/compact` は全履歴を「要約」するだけ → **重要情報の欠落リスク**
- 履歴の大半は**Bashコマンドの入出力**（判断に使われた後は参照されない）

## コンセプト

### 現行 `/compact` の問題

1. **全履歴を一括要約** — 直近の作業コンテキストも圧縮されてしまう
2. **情報の取捨選択が曖昧** — モデルが「何が後で必要か」を予見できない
3. **要約＝情報損失** — 設計判断・制約条件など不可逆な情報が消える

### Throughline のアプローチ

**「圧縮」ではなく「構造化」。古い部分だけ。直近はそのまま残す。何も捨てない。**

---

## 3層アーキテクチャ

会話コンテキストをツリー構造で管理する。層ごとにコンテキスト注入の粒度を制御。

```
Turn 7: 「ServerManagerを再起動して」
│
├── Layer 1 (骨格)    ← 常にコンテキストに存在
│   └── "ServerManager再起動 → 成功"
│
├── Layer 2 (判断)    ← 基本的にコンテキストに存在
│   ├── [DECISION] Electron起動検出にSleep 4秒必要
│   └── [ISSUE]    3秒では不足（起動ラグあり）
│
└── Layer 3 (詳細)    ← コンテキスト外（SQLiteに永続化、オンデマンド参照）
    ├── Get-Process → PID 19048 electron
    ├── Stop-Process → stopped
    ├── npm start → background ID: bazIqox0f
    ├── Sleep 3 → Exit code 1（検出失敗）
    └── Sleep 4 → Count 1（検出成功）
```

### 各層の定義

| Layer | 名称 | コンテキスト | 内容 | トークンコスト |
|-------|------|-------------|------|---------------|
| **L1** | 骨格 (Skeleton) | **常駐** | ターンの意図と結論。1行サマリ | 極小（~10 tok/turn） |
| **L2** | 判断 (Judgment) | **常駐** | 決定・制約・未解決問題。構造化タグ付き | 小（~50 tok/turn） |
| **L3** | 詳細 (Detail) | **退避** | コマンドIN/OUT、生レスポンス、スタックトレース | 大（~2,000+ tok/turn） |

### 期待効果

```
従来:  1ターンあたり ~2,000+ トークン（生データ丸ごと）
SC後:  1ターンあたり ~60 トークン（L1 + L2のみ）
削減率: 約97%
情報損失: ゼロ（L3はSQLiteに全量保存、オンデマンドで参照可能）
```

### L2 分類カテゴリ

| カテゴリ | タグ | 説明 | 例 |
|---------|------|------|-----|
| 設計判断 | `DECISION` | 技術選定、方式決定 | "通信方式: WebSocket (port 443)" |
| 制約条件 | `CONSTRAINT` | 禁止事項、前提条件 | "ポート8080使用不可（FW制限）" |
| 背景情報 | `CONTEXT` | プロジェクト要件、状況 | "Windows / Linux両対応が必須" |
| 実装済み | `IMPL` | 完了した作業のサマリ | "トークンダッシュボード実装済み" |
| 未解決 | `ISSUE` | バグ、TODO、要検討事項 | "起動ラグにより検出タイミング要調整" |

---

## SQLite スキーマ設計

### DB ファイル配置

```
~/.throughline/
├── throughline.db       # メインDB
├── throughline.db-wal   # WALモード（書き込み性能）
└── config.json            # ユーザー設定
```

### テーブル設計

```sql
-- セッション管理
CREATE TABLE sessions (
  session_id    TEXT PRIMARY KEY,
  project_path  TEXT NOT NULL,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_active   TEXT NOT NULL DEFAULT (datetime('now')),
  total_turns   INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'active'  -- active | compacted | closed
);

-- Layer 1: 骨格（ターンの1行サマリ）
CREATE TABLE skeletons (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  turn_number   INTEGER NOT NULL,
  role          TEXT NOT NULL,           -- user | assistant
  summary       TEXT NOT NULL,           -- "ServerManager再起動 → 成功"
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, turn_number, role)
);

-- Layer 2: 判断（構造化された決定・制約・問題）
CREATE TABLE judgments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  turn_number   INTEGER NOT NULL,
  category      TEXT NOT NULL,           -- DECISION | CONSTRAINT | CONTEXT | IMPL | ISSUE
  content       TEXT NOT NULL,           -- 構造化された判断内容
  resolved      INTEGER DEFAULT 0,       -- ISSUEが解決済みかどうか
  resolved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_judgments_session_cat ON judgments(session_id, category);
CREATE INDEX idx_judgments_unresolved ON judgments(session_id, resolved) WHERE resolved = 0;

-- Layer 3: 詳細（コマンドIN/OUT、生データ）
CREATE TABLE details (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  turn_number   INTEGER NOT NULL,
  tool_name     TEXT,                    -- Bash | Write | Edit | Read | etc.
  input_text    TEXT,                    -- コマンド入力 / ツール引数
  output_text   TEXT,                    -- コマンド出力 / ツール結果
  exit_code     INTEGER,
  token_count   INTEGER,                -- この詳細のトークン推定値
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_details_session_turn ON details(session_id, turn_number);

-- コンテキスト注入ログ（デバッグ・分析用）
CREATE TABLE injection_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  event_type    TEXT NOT NULL,           -- pre_compact | context_compaction | on_demand
  layers_sent   TEXT NOT NULL,           -- "L1+L2" | "L1+L2+L3:turn7"
  token_before  INTEGER,
  token_after   INTEGER,
  injected_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### クエリ例

```sql
-- コンテキスト注入用: L1+L2を生成（古いターンのみ）
SELECT
  s.turn_number,
  s.summary,
  json_group_array(
    json_object('category', j.category, 'content', j.content)
  ) AS judgments
FROM skeletons s
LEFT JOIN judgments j ON s.session_id = j.session_id AND s.turn_number = j.turn_number
WHERE s.session_id = ?
  AND s.turn_number < ?  -- 直近Nターンより古いもの
GROUP BY s.turn_number
ORDER BY s.turn_number;

-- 未解決ISSUEだけ取得（常にコンテキストに含めるべき）
SELECT turn_number, content, created_at
FROM judgments
WHERE session_id = ? AND category = 'ISSUE' AND resolved = 0
ORDER BY turn_number;

-- オンデマンド: 特定ターンのL3詳細を取得
SELECT tool_name, input_text, output_text, exit_code
FROM details
WHERE session_id = ? AND turn_number = ?
ORDER BY id;

-- 分析: セッションごとのトークン削減効果
SELECT
  session_id,
  SUM(token_count) AS total_detail_tokens,
  COUNT(*) AS detail_count
FROM details
GROUP BY session_id;
```

---

## 処理フロー

```
                     ┌─────────────────────────┐
                     │   Claude Code セッション   │
                     └────────┬────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  PostToolUse Hook  │  ← 毎ツール実行後
                    │  (detail-capture)  │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  L3をSQLiteに保存  │  ← リアルタイムで詳細を永続化
                    │  (tool名, IN/OUT)  │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼──────────┐
                    │   Stop Hook         │  ← Claudeが応答完了するたび
                    │   (turn-processor)  │
                    └─────────┬──────────┘
                              │
               ┌──────────────▼──────────────┐
               │  ターンを分析・構造化         │
               │  ├─ L1: 1行サマリ生成        │
               │  └─ L2: DECISION/CONSTRAINT  │
               │         /CONTEXT/IMPL/ISSUE  │
               │         を抽出               │
               └──────────────┬──────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  L1 + L2をSQLiteに │
                    │  保存              │
                    └─────────┬─────────┘
                              │
                 ┌────────────▼────────────┐
                 │  トークン閾値チェック     │
                 │  超過? ──→ compact推奨   │
                 └────────────┬────────────┘
                              │
              ┌───────────────▼───────────────┐
              │  PreCompact / ContextCompaction │
              │  ├─ 古いターンのL1+L2を        │
              │  │  additionalContextとして注入 │
              │  ├─ 未解決ISSUEは常に含める     │
              │  └─ L3はSQLiteに残存（参照可能）│
              └───────────────────────────────┘
```

---

## 実装方針

### 1. Hooks 構成

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash|Write|Edit|Read",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/detail-capture.mjs"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/turn-processor.mjs"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/throughline.mjs"
          }
        ]
      }
    ]
  }
}
```

### 2. 主要モジュール

| モジュール | Hook Event | 役割 |
|-----------|-----------|------|
| `detail-capture.mjs` | PostToolUse | ツール実行のIN/OUTをリアルタイムでSQLite L3に保存 |
| `turn-processor.mjs` | Stop | ターン完了時にL1(サマリ)+L2(判断)を生成・保存。トークン閾値チェック |
| `throughline.mjs` | PreCompact | 古いターンのL1+L2をadditionalContextとして注入。未解決ISSUE含む |
| `db.mjs` | — | SQLite接続管理。better-sqlite3使用（同期API、Node.js軽量） |
| `classifier.mjs` | — | ターン内容をDECISION/CONSTRAINT/CONTEXT/IMPL/ISSUEに分類 |
| `token-estimator.mjs` | — | tiktoken互換のトークン数推定 |

### 3. ツール実行履歴の構造化ルール

#### 原則

コマンドの実行結果は **その場でClaudeの判断に消費され、役目を終える情報** である。
ただし **捨てるのではなく、L3としてSQLiteに退避する。** オンデマンドで参照可能。

#### 構造化の実例

```
Before（生データ、コンテキスト内 ~2,000+ トークン）:
  IN:  powershell -Command "Get-Process electron..."
  OUT: Id 19048, Name electron
  IN:  powershell -Command "Stop-Process -Name electron..."
  OUT: stopped
  IN:  cd "C:\...\ServerManager" && npm start &
  OUT: Command running in background with ID: bazIqox0f
  IN:  powershell -Command "Start-Sleep -Seconds 3; Get-Process electron..."
  OUT: Exit code 1
  IN:  powershell -Command "Start-Sleep -Seconds 4; (Get-Process electron).Count"
  OUT: 1

After（L1+L2のみコンテキスト内、~60 トークン）:
  L1: "ServerManager再起動 → 成功"
  L2: [DECISION] Electron起動検出にSleep 4秒必要（3秒では不足）
  L3: → SQLite details テーブルに全5コマンド分を保存（オンデマンド参照可）
```

### 4. 分類ロジック（classifier.mjs）

**方式: ハイブリッド（採用）**
- まずヒューリスティックで粗分類（トークンゼロ）
  - ツール使用履歴: Write/Edit → IMPL、Bash → IMPL or ISSUE（exit codeで判定）
  - キーワードパターン: 「〜に決めた」→ DECISION、「〜は禁止」→ CONSTRAINT
- 判定が曖昧なものだけLLMに投げる（最小限のトークン消費）
- 分類精度の統計をinjection_logに記録し、ヒューリスティックの改善に活用

### 5. オンデマンドL3参照

```
/sc-detail <turn_number>   # カスタムスラッシュコマンド
```

1. Claudeがコンテキスト内のL1+L2から該当ターンを特定
2. スラッシュコマンド or MCPツールでSQLiteからL3を取得
3. additionalContextとしてそのターンのL3のみを一時注入

### 6. 自動コンパクト閾値設定

Throughline の核心は「序盤から積極的にコンテキストを削減する」ことです。  
これを実現するため、`install.mjs` が Claude Code の自動コンパクト閾値を引き下げます。

**環境変数：**
```
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=10
```

- デフォルト（未設定時）は約95%。コンテキストが満杯になってから初めて圧縮される
- Throughline は10%（デフォルト値）に設定し、早期かつ頻繁にコンパクトを発火させる
- コンパクト後は L1+L2 のみ（~60 tok/turn）に置換されるため、すぐに容量が回復する
- 結果として「コンテキストが常に小さく保たれる」状態を実現

**設定場所：** `install.mjs` がプロジェクトの `.claude/settings.json` に自動書き込み  
**カスタマイズ：** インストール時に閾値を指定可能（例: `node install.mjs --threshold 20   # 例: 20%に変更`）

```json
{
  "env": {
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "10"
  }
}
```

**ユーザー体験：** `node install.mjs` を一度実行するだけで、あとは完全自動。  
ユーザーは何も意識しなくてよい。

### 7. クロスプラットフォーム対応

- 全hookスクリプトは `.mjs`（Node.js ESM）で統一
- `node .claude/hooks/xxx.mjs` でWindows / Linux / macOS全対応
- bash / PowerShell 依存なし
- SQLiteはbetter-sqlite3（ネイティブビルド済みバイナリ提供あり）

---


## コンテキスト操作の技術的根拠

### Anthropic公式: Context Editing（Beta）

Anthropic APIには「Context Editing」というベータ機能が存在する。

- **Tool result clearing**: 古くなったツール実行結果をコンテキストから除去できる
- **自動警告**: クリア閾値に近づくと、Claudeに重要情報の保存を促す警告が自動送信される
- **メモリファイル連携**: クリアされる前に重要な情報をメモリファイルに退避可能

→ **Anthropicは「セッション途中でコンテキストを削る」ことを公式に想定・サポートしている。**
→ Throughlineの設計思想は、このAPIが示す方向性と完全に一致する。

---

## 開発フェーズ

### Phase 1: MVP
- SQLiteスキーマ作成 + db.mjs
- detail-capture: PostToolUseでL3をリアルタイム保存
- turn-processor: StopでL1(サマリ)生成・保存
- 直近10ターン保護ルール
- install.mjs: hooks設定 + `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=10` を `.claude/settings.json` に書き込み

### Phase 2: 構造化記憶
- classifier: L2分類（ハイブリッド方式）
- L2重複排除: contentハッシュによる同一判断の多重注入防止
- throughline: PreCompactでL1+L2注入
- /sc-detail コマンドでL3オンデマンド参照
- /sc-search コマンドでL3をキーワード検索（SQLite FTS5）
- injection_logによる効果測定

### Phase 3: 公開
- GitHub公開・README・npm配布
- ベンチマーク（compact前後のトークン削減率）

---

## 配布計画

### リポジトリ構成（予定）

```
throughline/
├── README.md
├── package.json
├── install.mjs              # ワンコマンドセットアップ
├── src/
│   ├── db.mjs               # SQLite管理
│   ├── detail-capture.mjs   # PostToolUse hook
│   ├── turn-processor.mjs   # Stop hook
│   ├── throughline.mjs    # PreCompact hook
│   ├── classifier.mjs       # L2分類ロジック
│   └── token-estimator.mjs  # トークン推定
├── commands/
│   └── sc-detail.md          # L3参照カスタムコマンド
└── docs/
    ├── CONCEPT.md            # この文書
    ├── BENCHMARKS.md         # 実測データ
    └── SCHEMA.md             # DBスキーマ詳細
```

### ターゲットユーザー

- Claude Code MAX契約者（パワーユーザー）
- CLAUDE.md + hooks を活用している中〜上級者
- トークン消費に課題を感じている開発者

### 差別化ポイント

- **実データ駆動**: SmartClaudeの$4,211/月相当の分析に基づく設計
- **情報損失ゼロ**: 3層構造で「捨てずに構造化」
- **序盤から積極的に削減**: 閾値10%の自動コンパクトで常にコンテキストを小さく保つ
- **完全自動**: インストール後は何もしなくていい。ユーザー操作ゼロ
- **シンプル**: セッション内完結。余計な機能を持たない
- **クロスプラットフォーム**: Windows / Linux / macOS対応
- **既存ワークフロー非破壊**: hooks経由で透過的に動作

---

## 備考

- このコンセプトはBellの短期記憶DB設計と同じ思想に基づく
- SmartClaudeの実データ（履歴87%問題）がこの設計の根拠
- 最終的にはClaude Code本体に取り込まれるべき機能だが、それを待たずに自前で実装・公開する
- Anthropic公式のContext Editing APIが、このコンセプトの正当性を裏付けている
