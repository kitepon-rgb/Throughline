# Throughline: Claude / Codex 両対応計画

この文書は Throughline repository に貼り付けるための実装ブリーフです。目的は、Throughline を Claude Code と Codex の両方から安全に使える形へ育てることです。

## この文書の位置づけ

この文書は **Claude / Codex 両対応の architecture brief** です。

関連文書:

| 文書 | 役割 |
|---|---|
| [05_codex_first_roadmap.md](05_codex_first_roadmap.md) | 2026-05-06 以降の次フェーズ計画。Codex primary 実用化を先行する |
| [06_codex_trim_rollback_fix_plan.md](06_codex_trim_rollback_fix_plan.md) | 2026-05-06 incident 後の修正計画。2026-05-08 の controlled smoke 後、過剰な Codex trim blocker は解除し、restore-safety / host primitive audit は diagnostics として扱う |
| [archive/07_codex_trim_implementation_plan.md](archive/07_codex_trim_implementation_plan.md) | この文書と rollback trim の気づきを統合した旧計画と実装履歴。完了済み根拠として参照する |
| [09_rollback_context_trim_insight.md](09_rollback_context_trim_insight.md) | conversation-only rollback を「model-visible context の delete primitive」と見る設計メモ |

この文書は Codex adapter / sidecar integration の方針を定義する。今後の実装順は [05_codex_first_roadmap.md](05_codex_first_roadmap.md) を優先する。

## 目標

Throughline は agent-neutral な handoff / context compression infrastructure になるべきです。

Claude Code transcript と handoff behavior は守りつつ、Codex primary bridge と `codex-sidecar` 経由の compact context も生成できるようにします。現行の `HandoffRecord` は安定した中間表現だが、保存元はまだ Claude transcript 由来であり、Codex capture を実装して初めて source adapter が Codex 由来になる。

目指す形:

- Throughline core は特定 agent に依存しない。
- Claude transcript support は first-class かつ stable のまま維持する。
- Codex support は `throughline_handoff` context block、Codex primary entrypoint、Codex CLI backend、`codex-sidecar` integration として追加する。
- 既存の Claude handoff behavior を壊さない。

## 優先順位

1. Throughline を Codex primary で使えるようにする。Codex primary の L2 -> L1 backend は Codex CLI を本線にする。
2. Codex で Claude Rewind 相当の context trim を完成させる。2026-05-09 時点では Codex current-thread trim execute / auto-refresh は再有効化済みで、DB memory を必須にし、turn-count mismatch は diagnostics と app-server count 由来の rollback `numTurns` 補正に使う。
3. そのあと Claude 側の `/rewind` UX / 自動化 surface を詰める。

Claude transcript handling の置き換えから始めないでください。Codex 対応は adapter / bridge / Codex primary entrypoint として追加します。

Claude primary で `codex-sidecar` が使えない場合は、現在の Claude subagent behavior をそのまま維持します。Codex 向け adapter / bridge が存在するからといって、既存の Claude path を削ったり劣化させたりしないでください。Codex primary の可用性は Codex CLI / app-server / rollout の実測で別に判定します。

## Architecture 方針

概念上、次の layer に分けます。

| Layer | Responsibility |
|---|---|
| Agent-neutral core | handoff record、compression output、reference、persistence、validation |
| Claude adapter | Claude Code transcript parsing、tool I/O assumption、Claude handoff command |
| Codex adapter | `throughline_handoff` context block、`codex-sidecar` request shaping、result capture |
| Shared fixtures | Claude / Codex adapter の両方で使う handoff example と expected output |

Codex path が Claude internals を parse するのは、それが明示的に adapter の責務である場合だけにしてください。core は stable handoff object を扱うべきです。

## Codex Sidecar Integration

この節は `codex-sidecar` integration の設計です。Codex primary の capture / L2 -> L1 backend は [05_codex_first_roadmap.md](05_codex_first_roadmap.md) を優先します。

Sidecar 向けには、Throughline が `codex-sidecar` contract に合う plain JSON context block を生成します。

```json
{
  "kind": "throughline_handoff",
  "source": "throughline",
  "trust": "local",
  "summary": "In-flight handoff: Next: continue",
  "data": {
    "throughlineHandoffSchemaVersion": 1,
    "handoffRecordVersion": 1,
    "sessionId": "session-id",
    "projectPath": "/repo",
    "sourceAgent": "claude",
    "hostMode": "claude-primary",
    "intent": "continue implementation",
    "constraints": ["preserve Claude transcript contract"],
    "originSessionIds": ["old-session"],
    "stats": {},
    "memory": {},
    "detailReferences": [
      {
        "type": "throughline_detail",
        "label": "tool_input:Bash",
        "command": "throughline detail 12:00:01",
        "sourceId": "toolu_1",
        "detailKind": "tool_input",
        "originSessionId": "old-session",
        "turnNumber": 2
      }
    ]
  }
}
```

`codex-sidecar` の top-level `references` は `path` 必須です。Throughline の DB /
`throughline detail <時刻>` 参照は `data.detailReferences` に置きます。file path /
line reference は既知の場合だけ top-level `references` に足し、必須にはしません。
`SidecarContextBlock` は top-level `schemaVersion` を保持しないため、Throughline 側の
schema version は `data.throughlineHandoffSchemaVersion` に入れます。
`hostMode` は `claude-primary` / `codex-primary` / `unknown` を明示指定します。自動 host-agent detection は初期実装に入れません。

Codex-facing workflow では、この context block を次の用途に使います。

- `codex_explore`: previous handoff context を使って repo question に答える。
- `codex_review`: last handoff を intent として current changes を review する。
- `codex_opinion`: handoff に含まれる plan を challenge する。
- `codex_risk_check`: handoff が触れている risky area を確認する。
- `codex_work`: isolated worktree で小さな scoped task を続行する。

## Claude Behavior を守る

コード変更の前に、現在の Claude contract を特定して文書化してください。

- transcript file shape
- tool input / output parsing assumption
- compaction format
- handoff markdown / JSON schema
- command name と argument
- resume behavior
- Claude session がまだ動くことを示す test / fixture

Codex のために既存の Claude-facing field を rename しないでください。必要なら Codex adapter projection を追加します。

## Background Subagent Shift

現行 Throughline で subagent 的に外部 model call しているのは、Stop hook の
L2 → L1 要約だけです。具体的には [src/haiku-summarizer.mjs](../src/haiku-summarizer.mjs)
が `claude -p --model claude-haiku-4-5-*` を呼びます。

移行方針:

- Claude primary では、`codex-sidecar diagnostics --project <repo> --preset summarize-l1` が成功する環境では、L2 → L1 要約に `codex-sidecar` を使う。
- Claude primary では、`codex-sidecar` が disabled / unavailable / diagnostics failure / run failure の環境では、現行の Claude Haiku 要約を維持する。
- Codex primary では、次フェーズ計画 [05_codex_first_roadmap.md](05_codex_first_roadmap.md) に従い、L2 → L1 要約 backend は Codex CLI を本線にする。Codex CLI が使えない場合は silent fallback せず明示 error とする。
- `/tl` の in-flight memo は [.claude/commands/tl.md](../.claude/commands/tl.md) が現行メイン Claude に書かせる handoff memo であり、subagent ではない。これは Codex sidecar へ移さない。

handoff review、continuity check、risk analysis などは現行 `src/` 実装には存在しません。
後続で追加する場合だけ、`throughline_handoff` context block と read-only sidecar workflow
として扱います。

## 懸念: Codex が Codex を呼ぶ場合

ユーザーが Claude から Throughline を使っている場合、この形には価値があります。

```text
Claude primary -> Throughline -> codex-sidecar -> Codex second opinion
```

一方、ユーザーが Codex から Throughline を使っている場合、次の形を無条件で行わないでください。

```text
Codex primary -> Throughline -> codex-sidecar -> Codex again
```

Codex-on-Codex が有効なのは、sidecar に別の境界がある場合だけです。

- isolated worktree から実行される。
- durable `SidecarResult` を生成する。
- diagnosis 用の raw App Server log を書く。
- critic / reviewer / risk-analyst など prompt role が明確に違う。
- independent second pass として明示的に要求されている。

別の境界がないなら、Throughline は別の Codex に委譲せず、現在の Codex session に handoff を直接 consume させてください。
Throughline 自体を Codex primary から使う場合は、まず [05_codex_first_roadmap.md](05_codex_first_roadmap.md) の Codex primary capture / Codex active-work resume renderer / Codex CLI L2→L1 backend を本線にします。`throughline codex-capture` と `throughline codex-resume` が Codex primary の入口であり、`throughline codex-sidecar-diagnostics`、`throughline codex-sidecar-dry-run` などは sidecar を使う review / risk-check / second opinion の診断 surface です。

Recommended policy:

| Host agent | Sidecar choice |
|---|---|
| Claude | independent review、risk、exploration、scoped continuation には Codex sidecar を優先 |
| Codex | isolation、structured result capture、explicit second-pass review がある場合のみ Codex sidecar を使う |
| Unknown / automation | implicit recursion ではなく明示 config を要求 |

Sidecar availability policy:

この表は `codex-sidecar` の availability を表す。Codex primary の L2 → L1 backend availability ではない。

| Codex sidecar availability | Behavior |
|---|---|
| `unavailable` | `codex-sidecar` が存在しない、実行不能、この repo 向けに未設定、または diagnostics 失敗。既存の Claude subagent path を維持 |
| `configured` | `codex-sidecar diagnostics --project <repo>` が成功。request shaping、dry-run、docs、planned read-only integration は使ってよい |
| `operational` | `codex_explore` など read-only smoke が成功。approved review、explore、opinion、risk-check sidecar task に使ってよい |
| `work-capable` | `codex_work` smoke が成功し、allowed paths が設定済み。worktree-backed scoped edit に使ってよい |
| explicitly disabled | 既存の Claude subagent path を維持 |

これは hidden fallback ではありません。Claude primary の互換モードです。Codex sidecar が使えない環境では、現在の Claude-backed behavior を baseline とします。

「Codex sidecar が使える」の最小実用定義は、単に `codex` binary があることではありません。`codex-sidecar` が存在し、対象 repository で diagnostics を成功させられることです。`codex-sidecar` がない場合、Throughline は sidecar unavailable と扱ってください。Codex primary 自体の可用性は、Codex CLI と app-server / rollout の実測で別に判定します。

Preferred health check:

```bash
codex-sidecar diagnostics --project <repo> --preset review
```

Development-path health check:

```bash
node /home/kite/projects/codex-sidecar/packages/cli/dist/index.js diagnostics \
  --project <repo> \
  --preset review
```

Dry-run checks:

```bash
throughline codex-sidecar-dry-run \
  --project <repo> \
  --preset review \
  --context-file docs/throughline-handoff-context.example.json \
  "Review Throughline dual support request shape only."

throughline codex-sidecar-dry-run \
  --project <repo> \
  --preset risk-check \
  --context-file docs/throughline-handoff-context.example.json \
  "Risk-check Throughline dual support request shape only."
```

Structured result policy:

- Dry-run output is diagnostic evidence only; it is not persisted in Throughline memory.
- Real read-only sidecar runs return structured JSON on stdout. If the result contains `rawEventLogRef`, treat that as the canonical durable link to the App Server event log.
- Do not mix sidecar result JSON into L1/L2/L3 memory tables. If Throughline later needs durable indexing, add a separate `sidecar_runs` style record keyed by project / workflow / preset / status / `rawEventLogRef`.

## Implementation Checklist

- [x] 既存の Claude transcript / handoff contract を audit する。
- [x] adapter 変更前に、現在の Claude behavior を固定する test を追加する。
- [x] stable handoff object がまだない場合は追加する。
- [x] `throughline_handoff` 用の Throughline-to-`SidecarContextBlock` conversion path を追加する。
- [x] Codex context block の fixture snapshot を追加する。
- [x] Claude primary / Codex primary mode の docs を追加する。
- [x] Codex-on-Codex recursion を避ける explicit `hostMode` config を追加する。自動 detection は未実装。
- [x] background Claude subagent task を移す前に Codex sidecar availability check を入れる。sidecar absent または diagnostics failure は explicit `unavailable`。
- [x] sample handoff を使った read-only `codex-sidecar` smoke を追加する。2026-05-06 に `throughline_handoff` fixture + `codex-sidecar explore` で成功済み。
- [x] `review` / `risk-check` dry-run を追加する。2026-05-06 に `throughline_handoff` fixture + `throughline codex-sidecar-dry-run` で成功済み。
- [x] sidecar structured result は stdout JSON + `rawEventLogRef` link として扱い、Throughline memory tables には混ぜない方針を明文化する。

## Done Definition

Throughline が dual-supported になったと言える条件:

- 既存の Claude transcript / handoff behavior が通る。
- Codex が `throughline_handoff` context block を受け取れる。
- Throughline が Codex の structured result を保存または link できる。
- Codex primary mode が実質的な境界なしに recursive delegation しない。
- Codex-unavailable environment では既存の Claude subagent behavior を維持する。
- Claude、current Codex、Codex sidecar の使い分けが docs に説明されている。
