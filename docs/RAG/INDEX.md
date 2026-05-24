# Throughline RAG Index — Context Spec Knowledge Base

Built: 2026-05-24

This directory accumulates third-party specifications relevant to Throughline's mission ("コンテキスト削減しつつ過去の記憶を一切失わない") so design decisions are grounded in actual Claude Code / Anthropic API constraints rather than guesses.

## Folder layout

```text
docs/RAG/
├── INDEX.md (this file — synthesized findings, paths forward)
└── _raw/                       (verbatim spec extracts, kept close to source wording)
    ├── 01-hooks/
    │   └── hooks-reference-extract.md      ← Claude Code hooks reference
    ├── 02-messages-api/
    │   └── messages-api-extract.md         ← Anthropic Messages API spec
    ├── 03-settings/
    │   └── sessions-extract.md             ← /clear, /compact, /resume behavior
    └── 04-skills/
        └── initialUserMessage-investigation.md ← deep-dive on the killer field
```

---

## Question this RAG was built to answer

> Throughline は「コンテキスト削減しつつ過去の記憶を一切失わない」と定義されている。記憶を引き継いでいてもモデルがそれを自分の作業履歴として体感していないなら、その記憶は無意味なコンテキストである。
>
> Claude Code の hook 系内で **モデルが「これは自分の過去発話である」と認識する形** で記憶を注入する経路は、本当に存在しないのか?

## Hard findings from spec (verified, not guessed)

### Finding 1: `additionalContext` is a system reminder, not a user message

> "Claude Code wraps the string in a system reminder and inserts it into the conversation at the point where the hook fired. Claude reads the reminder on the next model request, but it **does not appear as a chat message** in the interface."
> — [Hooks reference](_raw/01-hooks/hooks-reference-extract.md#what-additionalcontext-actually-does-critical)

→ システムリマインダ = ブリーフィング扱い。モデルが「他人事」と感じる構造的原因。

### Finding 2: stdout from `SessionStart` / `UserPromptSubmit` / `UserPromptExpansion` is also a system reminder

> "any non-JSON text written to stdout is added as context"
> "Claude Code wraps the string in a system reminder"
> — [Hooks reference](_raw/01-hooks/hooks-reference-extract.md#stdout)

→ 現行 Throughline v0.4.12 の stdout 注入はこの経路。`additionalContext` と同じカテゴリ = 同じ「他人事」問題。

### Finding 3: `initialUserMessage` exists in the schema, but is **HEADLESS-ONLY**

Verified via [openclaude source](_raw/04-skills/initialUserMessage-investigation.md#the-critical-constraint-from-openclaude-source-comment):

```text
// SessionStart hooks can emit initialUserMessage — the first user turn for
// headless orchestrator sessions where stdin is empty.
```

→ Interactive mode (`/clear` シナリオ) では発火しない。我々の問題には使えない。

**2026-05-24 実機確認**: real Claude Code (v2.1.145) で `~/.throughline/initial-user-message-test.flag` を立てて SessionStart hook を JSON 出力モードに切り替え、`hookSpecificOutput.initialUserMessage` に 8 hex tracer 入りメッセージを乗せて `/clear` 後の cleared-me に「過去発話の tracer を message history だけ見て返して」と尋ねた。ラン (2) 13:33 tracer `9220a79c` (session `0979ad20-…`) → モデル応答 **「ない」**。openclaude のソースコメントが real CC でも妥当であることを実機で確認。詳細: [docs/THROUGHLINE_TRANSCRIPT_INJECTION_PLAN.md §6 Phase 0-6](../THROUGHLINE_TRANSCRIPT_INJECTION_PLAN.md#phase-0-6--hookspecificoutputinitialusermessage-経路-spike)

### Finding 4: Messages API treats all messages[] entries equally

> "When creating a new Message, you specify the prior conversational turns with the messages parameter, and the model then generates the next Message in the conversation."
> — [Messages API](_raw/02-messages-api/messages-api-extract.md#no-differentiation-between-real--synthetic-messages-key)

→ もし messages[] に synthetic な過去 turn を入れられれば、モデルは「本物」と区別できない。問題は CC が messages[] を hook から制御させていないこと。

### Finding 5: `/clear` preserves the JSONL but resets in-memory state

> "/clear: start fresh with an empty context. The previous conversation is saved and resumable"
> — [Sessions](_raw/03-settings/sessions-extract.md#clear-behavior-key)

→ CC は in-memory state を一次ソースに messages[] を構築。JSONL を外から書き換えても in-memory には反映されない (= Phase 0 / Phase 0-5 で実測確認済み)。

### Finding 6: `/compact` is the documented memory-preservation path

> "/compact [instructions]: replace history with a summary"

→ /compact は同一 session を継続したまま履歴を要約版に置換。**PreCompact / PostCompact hook が発火**。これが Anthropic 公式の「記憶圧縮しつつ継続」経路。

### Finding 7: First-party hook-dev SKILL omits `initialUserMessage`

[anthropics/claude-code/plugins/plugin-dev/skills/hook-development/SKILL.md](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/hook-development/SKILL.md) は SessionStart hook の `hookSpecificOutput` の `additionalContext` も `initialUserMessage` も触れていない。Plugin 開発者向けの公式チュートリアルですら触れない = どちらも primary 経路として推奨されていない可能性。

---

## Throughline 仮説の見直し

### 当初仮説 (D 経路)

「JSONL に user/assistant 行を append すれば、CC が messages[] 構築時にそれを読む」

**実測 (4 ラン): すべて「ない」 → 反証済み**

JSONL は read 対象ではなく、CC の in-memory state が messages[] のソース。書き込んでも再読込されない。

### 第二仮説 (initialUserMessage)

「`initialUserMessage` で interactive モードでも first user message を注入できる」

**spec 調査 (openclaude source): HEADLESS-ONLY → 反証済み**

### 第三仮説 (PreCompact での再投影)

未検証。`/compact` のタイミングで PreCompact hook が「これを summary に必ず含めろ」と影響を与えられるなら、compaction 後の messages[] は本物の assistant turn として要約を含む可能性。

---

## ここから取れる現実的な道 (3 つ)

### 道 A: スコープを `/compact` に切り替え

- Throughline は `/clear` を諦め、`/compact` への置換を提案
- PreCompact hook で「直近 N turn を保持し、それ以前を summary に置換」のロジックを差し込む
- 同一 session 内なので messages[] は real assistant turn として要約を持つ → 本人体感を維持
- 制約: ユーザーの習慣 ("/clear で切り替える") から外れる; /compact は context full のときに自動発火する別経路でもあるので、頻発させると体感が変わる
- **`/clear` シナリオには適用できない** (構造的に別物)

### 道 B: Agent SDK / 自前ランタイム (= E)

- Claude Code を捨てて Agent SDK (Python or TypeScript) でラッパーを書く
- messages[] を完全制御 — synthetic user/assistant turn を自由に prepend
- /clear に相当する UX は自前で実装、内部的には messages[] を選択的に圧縮
- 制約: 大改修。Throughline は plugin から product になる
- これが「本人体感」を達成する唯一の正攻法

### 道 C: 現状受容 + A2.0 文言調整

- 現行 stdout 注入のままで継続
- 案内文の文言を改善 (現行 A 実装) で「他人事感」を多少緩和
- 「本人体感」までは届かないが、「『何のこと？』が出ない」レベルは達成済み
- 制約: Throughline のミッション定義 (「体感」まで含む) を満たさない

---

## 推奨される判断順

1. **Throughline のミッション定義の再確認**:
   - 「体感まで保証」が必須 → 道 B (E pivot) しかない。CC plugin である限り構造的に不可能。
   - 「配送までで OK、体感は best-effort」 → 道 C で十分。

2. **`/clear` という UI シグナルへのこだわり**:
   - 必須 → 道 B または C。/compact は別物。
   - 妥協可能 → 道 A も視野 (ユーザーに /compact を勧める)

3. **着手コスト**:
   - 道 C: 小 (文言調整のみ。実装済み)
   - 道 A: 中 (PreCompact hook + summary 制御)
   - 道 B: 大 (別プロジェクト相当)

---

## 蓄積予定 (今後 RAG に足すべき調査)

- [ ] PreCompact / PostCompact hook の詳細仕様 (specific output schema)
- [ ] Agent SDK Python / TypeScript の messages[] 制御 API
- [ ] `claude --continue` / `--resume` の実 messages[] 構築フロー (JSONL → API call の変換)
- [ ] CC のバージョンによる hook 挙動差分 (2.1.128 で source='clear' が変わった等)
- [ ] 他の OSS CC 互換実装 (openclaude 以外) の messages[] 構築コード
- [ ] Codex の同等問題と解決手法 (Throughline は Claude / Codex 両対応)
