# Throughline Codex Monitor 実装計画

Status: implemented
Date: 2026-05-06
Amended: 2026-05-09 — monitor now also discovers Codex rollouts directly
from `~/.codex/sessions/**/rollout-*.jsonl`, so Codex visibility no longer
depends on the Stop hook writing a Throughline state file.

この計画は、既存の Claude-primary monitor 経路を置き換えずに、
`throughline monitor` へ Codex 対応を追加するためのもの。

## 目的

`throughline monitor` で、Claude セッションと並べて Codex セッションも
active session として表示できるようにする。

token monitor 自体はすでに Throughline の Node.js CLI であり、Claude ランタイム
機能ではない。現時点の制約は、monitor に渡す state producer と usage reader が
Claude 寄りになっている点にある。

- Claude hooks は `~/.throughline/state/<session_id>.json` を書く。
- Claude transcript JSONL には実測 `message.usage` token sample がある。
- 実装前の Codex Stop hook は DB capture のみで、monitor 用 state / token usage を
  書いていなかった。

Codex 対応では、既存 monitor contract の周辺に Codex adapter / projection を追加する。
Claude hooks、transcript parsing、slash command、baton、resume behavior は rename / 劣化
させない。

2026-05-09 以降は、Codex Stop hook が state を書く経路に加えて、
monitor reader 自体が Codex rollout index を直接 discovery する。これにより、
host が Stop hook をまだ dispatch していない現在 thread でも monitor に表示される。

## 非目的

- Claude transcript usage parsing を置き換えない。
- `~/.codex/hooks.json` を手編集しない。hook 更新は `throughline install` に任せる。
- Caveat / Spotter など既存 Codex hooks を削除・劣化させない。
- Codex token count を、host 実測 sample が無いのに exact と主張しない。
- 実測 usage が無い場合に、黙って estimate へ切り替えない。estimate は必ず表示上も
  data 上も明示する。

## 現在の contract

Monitor reader:

- `throughline monitor` は `src/token-monitor.mjs` に dispatch される。
- `~/.throughline/state/` の session state files を読む。
- Codex については `~/.codex/sessions/**/rollout-*.jsonl` から現在 project の
  rollout candidates も読む。`--all` または `--session` 時は全 project 候補を読む。
- 現在の state file は主に次を持つ。
  `sessionId`, `projectPath`, `transcriptPath`, `pid`, `updatedAt`, optional `usage`
- `state.usage` があれば monitor はそれをそのまま表示する。
- `state.usage` が無く、`transcriptPath` があれば、
  `src/transcript-usage.mjs` で Claude transcript usage を読む。
- したがって `transcriptPath` は Claude transcript fallback 用の field として残す。
  Codex rollout path を同じ field に詰めると、monitor が Claude transcript parser に
  読ませてしまう可能性があるため、Codex 用には別 field を追加する。
- `pid` は既存 state schema に残っているが、現行 stale 判定は `updatedAt` ベース。
  Codex Stop hook は短命 process なので、Codex の active 判定に hook process PID を
  意味づけない。
- state file が無い Codex rollout candidate は、monitor 内で synthetic state として扱う。
  既存 state がある場合は、state の `usage` snapshot を保持しつつ discovered
  `rolloutPath` / `updatedAt` を合流する。

Claude writer:

- `src/turn-processor.mjs` が Claude Stop 時に state を書く。
- 可能なら Claude transcript JSONL から usage snapshot を state に固定する。
- `src/session-start.mjs` と `src/prompt-submit.mjs` も VSCode monitor task を
  provision する。

Codex writer:

- `src/cli/codex-hook.mjs` は Codex rollout を DB capture する。
- 実装後は `codex:<thread_id>` の monitor state も書く。
- Codex Stop hook から VSCode monitor task を provision する。
- Codex rollout の `event_msg` / `token_count` を monitor usage として渡す。

## 提案設計

### 1. Monitor state を host-aware にする

state file に optional な host metadata を追加する。

```json
{
  "sessionId": "codex:019df...",
  "host": "codex",
  "projectPath": "/repo",
  "transcriptPath": null,
  "rolloutPath": "/home/user/.codex/sessions/.../rollout.jsonl",
  "updatedAt": 1770000000000,
  "usage": {
    "tokens": 12345,
    "model": "codex",
    "contextWindowSize": 200000,
    "contextWindowEstimated": true,
    "outputTokens": 0,
    "estimated": true,
    "source": "codex-rollout-chars-div-4"
  }
}
```

互換ルール:

- `host` が無い既存 state は `claude` と扱う。
- 既存 Claude state file はそのまま有効。
- normalization は `readAllSessionStates()` 側で行い、monitor 本体が
  `state.host ?? "claude"` を各所で繰り返さないようにする。

### 2. Codex Stop hook から monitor state を書く

Codex rollout capture 成功後、`runCodexStopHook` が state file を書く。

- `sessionId`: `codex:<thread_id>`
- `host`: `codex`
- `projectPath`: payload cwd または process cwd
- `pid`: hook process id を入れてよいが、Codex active 判定には使わない
- `transcriptPath`: `null`。Claude transcript parser に Codex rollout を読ませない
- `rolloutPath`: 現在の Codex rollout path が分かる場合だけ入れる
- `updatedAt`: 現在時刻
- `usage`: Codex usage sample が取れる場合は入れる。`token_count` が無い場合は
  labeled estimate を入れる

最初の milestone は、usage 無しでも Codex active session が monitor に出ることだった。
実装では verified `token_count` usage または明示 estimate まで入れる。

### 3. Codex usage adapter を追加する

小さな adapter を追加する。候補は `src/codex-usage.mjs`。

Codex data から monitor 用 usage sample を作る。

優先順位:

1. Codex rollout の `event_msg` / `token_count` が verified shape として存在するなら、
   それを読む。実 rollout でこの shape を確認済み。
2. 実測が無い場合は、active rollout text length から既存 `estimateTokens` helper で
   `chars / 4` estimate を作る。

estimate しか無い場合、usage sample は必ず次を持つ。

- `estimated: true`
- `source: "codex-rollout-chars-div-4"`
- Codex の context window が未検証なら `contextWindowEstimated: true`

monitor 表示でも compact に `est` と出す。

### 4. Monitor core を小さく保つ

`src/token-monitor.mjs` を Codex parser にしない。

monitor は引き続き state を読んで描画するだけに寄せる。host 固有の解析は writer /
adapter 側に置く。

期待挙動:

- Claude state + real usage: 既存どおり表示。
- Codex state + estimated usage: token bar を表示し、`est` marker を付ける。
- Codex state + usage 無し: active session として表示し、token usage は未取得扱い。
- Codex discovered rollout + state 無し: synthetic Codex state として表示し、live rollout
  usage を読む。表示 ID は `codex:` prefix を外した raw thread id 先頭 8 桁にする。

### 5. VSCode monitor task provision を Codex にも接続する

Codex Stop hook でも、Claude hooks と同じく
`ensureMonitorTaskFile({ cwd, env })` を呼ぶ。

これにより体験を揃える。

- VSCode で project を開く。
- Codex を使う。
- Throughline Codex Stop hook が発火する。
- monitor task が存在する。
- Codex session が monitor に出る。

## TODO

- [x] `src/state-file.mjs` に host metadata support を追加する。
- [x] `src/state-file.mjs` に optional `rolloutPath` support を追加する。
- [x] `host` 無しの旧 state file を Claude として読む互換性を維持する。
- [x] `readAllSessionStates()` で state normalization を行う。
- [x] 旧 Claude state が読めることを test で固定する。
- [x] Codex state が読め、project filter に乗ることを test で固定する。
- [x] `src/token-monitor.mjs` の表示に compact な host 表示を足す。
- [x] estimated usage sample には `est` marker を表示する。
- [x] monitor UI は静かに保ち、説明文を増やしすぎない。
- [x] `src/codex-usage.mjs` または同等の Codex usage adapter を追加する。
- [x] Codex rollout JSONL に実測 token usage field があるか確認する。
- [x] 実測 usage がある場合、verified shape だけを parse し fixture test を置く。
- [x] 実測 usage が無い場合、active rollout text から labeled `chars / 4` estimate を作る。
- [x] Codex usage estimate shape の test を追加する。
- [x] Codex context window が未検証の場合は `contextWindowEstimated: true` を保持する。
- [x] `src/cli/codex-hook.mjs` で Codex Stop hook state writing を追加する。
- [x] monitor session id は `codex:<thread_id>` にする。
- [x] monitor が Codex rollout を直接 discovery し、state 未生成の current thread も表示する。
- [x] discovered rollout と既存 Codex state を merge し、state の usage snapshot を保持する。
- [x] Codex 表示 ID は `codex:` prefix を外した raw thread id 先頭 8 桁にする。
- [x] Codex state の `pid` を active 判定に使わないことを test / docs で固定する。
- [x] Codex state では `transcriptPath: null` とし、rollout path は `rolloutPath` に保存する。
- [x] Codex Stop hook から `ensureMonitorTaskFile` を呼ぶ。
- [x] Codex Stop hook が monitor state を書く test を追加する。
- [x] Codex Stop hook が DB capture / L1 summarize を従来通り行うことを test で保つ。
- [x] install tests で Caveat / Spotter hook preservation が壊れていないことを維持する。
- [x] `README.md` に Claude/Codex monitor support を追記する。
- [x] `CLAUDE.md` に Codex monitor adapter contract を追記する。
- [x] 実装完了後、`docs/THROUGHLINE_CODEX_FIRST_ROADMAP.md` に結果を記録する。
- [x] `CHANGELOG.md` を更新する。
- [x] focused tests を実行する:
  `rtk node --test src/state-file.test.mjs src/token-monitor.test.mjs src/codex-usage.test.mjs src/cli/codex-hook.test.mjs`
- [x] full validation を実行する:
  `rtk npm test`,
  `rtk npm pack --dry-run --json`,
  `rtk git diff --check`
- [x] installed Codex-facing assets / hook behavior を変えた場合は
  `rtk throughline install` を実行する。

## 受け入れ条件

- Codex Stop hook capture 後、`throughline monitor` に現在の Codex session が出る。
- Codex Stop hook state が無くても、現在 project の Codex rollout があれば
  `throughline monitor` に現在の Codex session が出る。
- Claude monitor behavior は既存どおり。
- Codex session は Codex と分かる。
- Codex token usage が estimate の場合、estimate と分かる。
- Codex context window が未検証の場合、分母も推定であることが data 上分かる。
- Codex monitor path が Claude transcript parsing を置き換えない。
- `~/.codex/hooks.json` の手編集は不要。

## 実装順

1. Host-aware state schema と互換 test。
2. Codex Stop hook が usage 無しでも monitor state を書く。
3. Monitor が Claude/Codex mixed state を描画する。
4. Codex usage adapter で実測 usage または labeled estimate を追加する。
5. Codex Stop hook から VSCode task provision を行う。
6. docs / changelog / install / full validation を通す。
