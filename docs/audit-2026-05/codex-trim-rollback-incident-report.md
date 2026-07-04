# Throughline Codex Trim Rollback Incident Report

Date: 2026-05-06 JST
Reporter context: Spotter project session `/home/kite/projects/Spotter`
Affected project: Throughline `/home/kite/projects/Throughline`
Codex thread: `019dfd6f-640e-7dd3-b163-3f9add39fde7`

## Summary

Throughline's Codex trim execution appears to have a serious durability bug.

After running:

```bash
rtk throughline trim --execute --host codex --all
```

Throughline reported successful rollback and memory injection:

```text
Status: executed
Reason: rollback_and_inject_sent
Read turns: 19
Resumed turns: 19
Turn count check: match
Expected turns: 19
Rollback sent: yes
Inject sent: yes
Injected items: 1
Injected memory source: throughline-db
Rollback candidate turns: 19
```

However, after VS Code was restarted, a previously rolled-back user turn reappeared as a new user message. The user stated they had only restarted VS Code and had not resent that prompt.

This means rollback/inject may affect the live Codex app-server thread but may not be durably safe across the VS Code / Codex restart restoration path.

## Impact

Severity: high.

The failure mode is not just stale context. A past user instruction can be resurrected and processed as a fresh user request after restart or reconnect.

In this incident the resurrected prompt was a harmless question:

```text
codexのtool.dbについても、Claudeと同様にグローバルにも存在していて、読み取りロジックは完全に同様なんだっけ
```

But if the resurrected turn had been an operational command such as publish, install, deploy, delete, rebuild, or migration work, Codex could execute an obsolete request.

## Observed Timeline

All timestamps below are UTC from the Codex rollout JSONL.

### Original User Turn

Rollout file:

```text
/home/kite/.codex/sessions/2026/05/06/rollout-2026-05-06T22-17-09-019dfd6f-640e-7dd3-b163-3f9add39fde7.jsonl
```

The original user prompt exists at:

```text
line 1276  2026-05-06T14:20:35.371Z  response_item role=user
line 1277  2026-05-06T14:20:35.371Z  event_msg user_message
```

Prompt:

```text
codexのtool.dbについても、Claudeと同様にグローバルにも存在していて、読み取りロジックは完全に同様なんだっけ
```

### Throughline Trim Execute

The trim command was invoked at:

```text
line 1781  2026-05-06T14:39:43.844Z  function_call
```

Command:

```bash
rtk throughline trim --execute --host codex --all
```

The command completed at:

```text
line 1790  2026-05-06T14:39:47.486Z  exec_command_end
line 1795  2026-05-06T14:39:53.765Z  function_call_output
```

Throughline reported:

```text
Status: executed
Reason: rollback_and_inject_sent
Rollback sent: yes
Inject sent: yes
Rollback candidate turns: 19
```

### Restart / Reconnect Symptoms

After the trim execution, the user observed Codex reconnect failures:

```text
Reconnecting... 2/5
Reconnecting... 3/5
Reconnecting... 4/5
Reconnecting... 5/5
stream disconnected before completion
```

The user then restarted VS Code.

### Duplicated User Turn

After the restart, the same prompt appeared again as if it were newly submitted:

```text
line 1864  2026-05-06T14:48:02.120Z  response_item role=user
line 1865  2026-05-06T14:48:02.121Z  event_msg user_message
```

Duplicated prompt:

```text
codexのtool.dbについても、Claudeと同様にグローバルにも存在していて、読み取りロジックは完全に同様なんだっけ
```

The user explicitly denied sending this prompt again:

```text
line 1883  2026-05-06T14:49:52.993Z  response_item role=user
line 1884  2026-05-06T14:49:52.993Z  event_msg user_message
```

User statement:

```text
俺はVSCを再起動しただけなんだよね。何が起きた？
```

## Evidence Commands Used

Duplicate prompt search:

```bash
rtk node -e "const fs=require('fs'); const p='/home/kite/.codex/sessions/2026/05/06/rollout-2026-05-06T22-17-09-019dfd6f-640e-7dd3-b163-3f9add39fde7.jsonl'; let i=0; for (const line of fs.readFileSync(p,'utf8').split('\n')) { i++; if (!line.trim()) continue; const row=JSON.parse(line); const payload=row.payload||{}; let text=''; let kind=''; if (row.type==='response_item' && payload.type==='message' && payload.role==='user') { kind='response_user'; text=(payload.content||[]).map(x=>x.text||x.input_text||'').join('\n'); } if (row.type==='event_msg' && payload.type==='user_message') { kind='event_user'; text=payload.message||''; } if (text.includes('codexのtool.dbについても')) console.log(JSON.stringify({line:i,timestamp:row.timestamp,kind,text:text.slice(0,160)})); }"
```

Output:

```json
{"line":1276,"timestamp":"2026-05-06T14:20:35.371Z","kind":"response_user","text":"codexのtool.dbについても、Claudeと同様にグローバルにも存在していて、読み取りロジックは完全に同様なんだっけ \n"}
{"line":1277,"timestamp":"2026-05-06T14:20:35.371Z","kind":"event_user","text":"codexのtool.dbについても、Claudeと同様にグローバルにも存在していて、読み取りロジックは完全に同様なんだっけ \n"}
{"line":1864,"timestamp":"2026-05-06T14:48:02.120Z","kind":"response_user","text":"codexのtool.dbについても、Claudeと同様にグローバルにも存在していて、読み取りロジックは完全に同様なんだっけ \n"}
{"line":1865,"timestamp":"2026-05-06T14:48:02.121Z","kind":"event_user","text":"codexのtool.dbについても、Claudeと同様にグローバルにも存在していて、読み取りロジックは完全に同様なんだっけ \n"}
{"line":1883,"timestamp":"2026-05-06T14:49:52.993Z","kind":"response_user","text":"ちょっとまってな　俺が\n\ncodexのtool.dbについても、Claudeと同様にグローバルにも存在していて、読み取りロジックは完全に同様なんだっけ \n\nを発言したことになっているんだが、\n俺はVSCを再起動しただけなんだよね。何が起きた？\n"}
{"line":1884,"timestamp":"2026-05-06T14:49:52.993Z","kind":"event_user","text":"ちょっとまってな　俺が\n\ncodexのtool.dbについても、Claudeと同様にグローバルにも存在していて、読み取りロジックは完全に同様なんだっけ \n\nを発言したことになっているんだが、\n俺はVSCを再起動しただけなんだよね。何が起きた？\n"}
```

Rollback / injection search:

```bash
rtk node -e "const fs=require('fs'); const p='/home/kite/.codex/sessions/2026/05/06/rollout-2026-05-06T22-17-09-019dfd6f-640e-7dd3-b163-3f9add39fde7.jsonl'; let i=0; for (const line of fs.readFileSync(p,'utf8').split('\n')) { i++; if (!line.trim()) continue; const row=JSON.parse(line); const s=JSON.stringify(row); if (s.includes('trim --execute') || s.includes('rollback_and_inject_sent') || s.includes('Rollback sent: yes')) console.log(JSON.stringify({line:i,timestamp:row.timestamp,type:row.type,payloadType:row.payload?.type,preview:s.slice(0,1000)})); }"
```

Relevant output:

```text
line 1781  2026-05-06T14:39:43.844Z  trim --execute command
line 1790  2026-05-06T14:39:47.486Z  exec_command_end, Status: executed, Rollback sent: yes, Inject sent: yes
line 1795  2026-05-06T14:39:53.765Z  function_call_output, Status: executed, Rollback sent: yes, Inject sent: yes
```

Durable rollback event search:

```bash
rtk node -e "const fs=require('fs'); const p='/home/kite/.codex/sessions/2026/05/06/rollout-2026-05-06T22-17-09-019dfd6f-640e-7dd3-b163-3f9add39fde7.jsonl'; let i=0; for (const line of fs.readFileSync(p,'utf8').split('\n')) { i++; if (!line.trim()) continue; const row=JSON.parse(line); const payload=row.payload||{}; if ((row.type==='event_msg' && String(payload.type||'').includes('rollback')) || JSON.stringify(row).includes('thread/rollback') || JSON.stringify(row).includes('thread/inject_items')) console.log(JSON.stringify({line:i,timestamp:row.timestamp,type:row.type,payloadType:payload.type,msg:JSON.stringify(payload).slice(0,260)})); }"
```

Initial analysis said this did not show a durable rollout-level `thread_rolled_back` event corresponding to the app-server rollback. That was incorrect.

Follow-up audit found:

```text
line 1775  2026-05-06T14:39:34.452Z  compacted
line 1778  2026-05-06T14:39:34.453Z  context_compacted
line 1784  2026-05-06T14:39:44.844Z  event_msg thread_rolled_back num_turns=19
```

The `compacted.replacement_history` at line 1775 contains the later-resurrected user prompt. Therefore the stronger failure hypothesis is not "rollback marker missing", but "rollback marker exists, while another restore source such as compacted replacement history or pending input can still reintroduce old user text".

## Current Hypothesis

The most likely failure path is:

```text
Throughline sends Codex app-server thread/rollback and thread/inject_items
↓
The live app-server thread reports success
↓
The rollout contains thread_rolled_back, but compacted.replacement_history or another restart / pending-input source still contains rollback-targeted user text
↓
VS Code restarts
↓
Codex restores from a source not covered by Throughline's current guarded execute checks
↓
A previously rolled-back user turn is restored as a fresh user message
```

This suggests that Codex app-server `thread/rollback` is not sufficient by itself as a durable trim primitive for VS Code restart/reconnect behavior unless the compacted / restart restore path is also verified.

## Throughline Areas To Inspect

The report does not modify Throughline. These are the areas likely involved:

```text
/home/kite/projects/Throughline/src/cli/trim.mjs
```

- `trim --execute --host codex --all`
- `runExecute`
- selection of rollout source versus DB memory source

```text
/home/kite/projects/Throughline/src/codex-app-server.mjs
```

- `runCodexTrimExecution`
- `thread/rollback`
- `thread/inject_items`
- post-inject read consistency check
- whether the check proves durable restore behavior or only live app-server state

```text
/home/kite/projects/Throughline/src/codex-rollout-memory.mjs
```

- `parseCodexRolloutFile`
- handling of `thread_rolled_back`
- assumptions about rollback events being present in rollout JSONL

## Recommended Immediate Guard

Until durable restart behavior is proven, `$throughline` should not automatically execute:

```bash
throughline trim --execute --host codex --all
```

Recommended short-term behavior:

- Keep `doctor`
- Keep `trim --dry-run`
- Keep `trim --preflight`
- Require explicit user action for `trim --execute`
- Add a warning that Codex app-server rollback may not survive VS Code restart

If automatic execution remains available, it should require an additional durable verification step:

```text
execute rollback/inject
read live thread
verify rollout JSONL contains durable rollback marker
verify compacted replacement history / restart restore sources cannot reintroduce rollback-targeted user text
restart/reconnect smoke or simulated restore check
only then report success as durable
```

## Suggested Regression Test Shape

A fake app-server test is not sufficient unless it models the persistence mismatch.

Recommended test:

1. Create a rollout JSONL with multiple user turns.
2. Simulate app-server `thread/rollback` returning success.
3. Do not mutate the rollout JSONL.
4. Run the restore / parse path used after restart.
5. Assert that Throughline refuses to call the trim durable, or warns that rollback is live-only.

Acceptance criteria:

- Throughline must not report a Codex trim as durable unless the restore source reflects the rollback.
- A rolled-back user turn must not be eligible to reappear as a fresh user request after restart.

## Open Questions

- Does Codex app-server expose a durable rollback primitive, or is `thread/rollback` live-session only?
- Is there a separate persisted thread store besides rollout JSONL that VS Code uses on restart?
- Can Throughline inject a durable marker that Codex restore respects?
- Should Throughline switch Codex trim from mutation-based rollback to resume-only memory rendering until durable rollback is proven?

## Bottom Line

Treat this as a blocker for automatic Codex trim execution.

The observed incident demonstrates that `trim --execute --host codex --all` can report success while a rolled-back user turn later reappears after VS Code restart. Throughline should not expose this as a safe default until durable rollback semantics are verified end to end.
