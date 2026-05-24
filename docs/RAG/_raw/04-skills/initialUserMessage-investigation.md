# `initialUserMessage` Field — Investigation Results

## Sources

- Official hooks reference: <https://code.claude.com/docs/en/hooks> (mentions field in SessionStart hookSpecificOutput shape)
- First-party hook-dev SKILL: <https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/hook-development/SKILL.md> (does NOT mention)
- Open-source CC implementation `Gitlawb/openclaude`:
  - `src/utils/hooks.ts` — schema definition
  - `src/utils/sessionStart.ts` — storage + retrieval mechanism
  - `src/cli/print.ts` — consumer (the critical one)
  - `src/main.tsx` — initialMessages array construction

## The schema (confirmed)

```typescript
// From openclaude src/utils/hooks.ts and src/types/hooks.ts
interface HookResult {
  additionalContext?: string
  initialUserMessage?: string
  watchPaths?: string[]
  updatedInput?: Record<string, unknown>
  // ...
}

// SessionStart hook output processing
case 'SessionStart':
  result.additionalContext = json.hookSpecificOutput.additionalContext
  result.initialUserMessage = json.hookSpecificOutput.initialUserMessage
  if ('watchPaths' in json.hookSpecificOutput && json.hookSpecificOutput.watchPaths) {
    result.watchPaths = json.hookSpecificOutput.watchPaths
  }
  break
```

## The CRITICAL constraint (from openclaude source comment)

```typescript
// src/cli/print.ts:
// SessionStart hooks can emit initialUserMessage — the first user turn for
// headless orchestrator sessions where stdin is empty.
takeInitialUserMessage,
```

**`initialUserMessage` is for HEADLESS MODE ONLY.** It's invoked when `claude -p` is launched and stdin doesn't provide a prompt — the hook can supply the "first user turn" as a substitute.

## Storage / consumption mechanism

```typescript
// src/utils/sessionStart.ts
// Set by processSessionStartHooks when a hook emits initialUserMessage;
// consumed once by takeInitialUserMessage. This side channel avoids changing
// the return type of processSessionStartHooks.
let pendingInitialUserMessage: string | undefined = undefined

if (hookResult.initialUserMessage) {
  pendingInitialUserMessage = hookResult.initialUserMessage
}

export function takeInitialUserMessage(): string | undefined {
  const v = pendingInitialUserMessage
  pendingInitialUserMessage = undefined
  return v
}
```

```typescript
// src/cli/print.ts
const hookInitialUserMessage = takeInitialUserMessage()
if (hookInitialUserMessage) {
  structuredIO.prependUserMessage(hookInitialUserMessage)
}
// then runHeadlessStreaming() processes the queue
```

## What this means for Throughline

`initialUserMessage` does NOT solve the `/clear` continuation problem because:

1. `/clear` is an INTERACTIVE mode operation
2. Interactive mode always has a user typing the next prompt — there's no "missing first user message" slot to fill
3. `initialUserMessage` is consumed by `print.ts` (print mode = `claude -p`), not by the interactive REPL

**Conclusion**: `initialUserMessage` is the wrong tool for our problem. It can't be used to make `/clear` continuation feel native.

## What IS the right tool? (As of this research)

For interactive `/clear`-then-prompt continuity, the available hook surfaces are:

- `additionalContext` → system reminder ("briefing" framing, what we have now)
- `stdout` (SessionStart/UserPromptSubmit/UserPromptExpansion) → system reminder (same as above)
- `PreCompact`/`PostCompact` hooks → fire on /compact, not /clear (different code path)
- `decision: block` for UserPromptSubmit → can block prompts, doesn't help inject memory
- Modifying transcript JSONL externally → ignored by CC's in-memory parent chain (proven dead via Phase 0 experiments)

**The current Claude Code hook system does NOT provide a documented mechanism to inject true conversation history (messages[]) into an interactive session after /clear.**

The only paths that would solve this are:

1. **Use /compact instead of /clear** — preserves session continuity in-place; PreCompact hook can influence the summary
2. **Agent SDK rewrite (E)** — bypass Claude Code's REPL, build a custom runtime that controls messages[] directly
3. **API-level proxy** — intercept the Claude Code → Anthropic API call and rewrite messages[]
