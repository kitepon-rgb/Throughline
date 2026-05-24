# Claude Code Hooks Reference — Extract

Source: <https://code.claude.com/docs/en/hooks> (fetched 2026-05-24)

## Hook events (31 total)

### Per-Session

- `SessionStart` — session begins or resumes
- `Setup` — when launched with `--init-only` / `--init` / `--maintenance`
- `SessionEnd` — session terminates

### Per-Turn

- `UserPromptSubmit` — user submits a prompt, before Claude processes it
- `UserPromptExpansion` — when a user-typed command expands into a prompt
- `Stop` — Claude finishes responding
- `StopFailure` — turn ends due to API error

### Per-Tool-Call

- `PreToolUse` — before tool call
- `PostToolUse` — after tool call succeeds
- `PostToolUseFailure` — after tool call fails
- `PostToolBatch` — after parallel tool batch resolves
- `PermissionRequest` — when permission dialog appears
- `PermissionDenied` — denied by auto mode classifier

### Agent/Team

- `SubagentStart` / `SubagentStop`
- `TaskCreated` / `TaskCompleted`
- `TeammateIdle`

### File/Config

- `InstructionsLoaded` — when CLAUDE.md / `.claude/rules/*.md` loaded
- `ConfigChange`
- `FileChanged`
- `CwdChanged`
- `WorktreeCreate` / `WorktreeRemove`

### Compaction

- `PreCompact` — before context compaction
- `PostCompact` — after context compaction

### MCP

- `Elicitation` / `ElicitationResult`

### Notification

- `Notification`

---

## Common input payload (all events)

```json
{
  "session_id": "abc123",
  "transcript_path": "/home/user/.claude/projects/.../transcript.jsonl",
  "cwd": "/home/user/my-project",
  "permission_mode": "default|plan|acceptEdits|auto|dontAsk|bypassPermissions",
  "hook_event_name": "PreToolUse",
  "effort": { "level": "low|medium|high|xhigh|max" },
  "agent_id": "optional-subagent-id",
  "agent_type": "optional-agent-name"
}
```

### SessionStart input

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "SessionStart",
  "source": "startup|resume|clear|compact",
  "model": "claude-sonnet-4-6"
}
```

### UserPromptSubmit input

```json
{
  "session_id": "abc123",
  "transcript_path": "...",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "Write a function to calculate the factorial of a number"
}
```

---

## hookSpecificOutput

Common shape:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "text string to inject into Claude's context"
  }
}
```

### What `additionalContext` actually does (CRITICAL)

> The `additionalContext` field passes a string from your hook into Claude's context window. **Claude Code wraps the string in a system reminder** and inserts it into the conversation at the point where the hook fired. Claude reads the reminder on the next model request, but it does not appear as a chat message in the interface.

**Placement by event:**

| Event Category | Placement |
|---|---|
| `SessionStart`, `Setup`, `SubagentStart` | At the start of the conversation, before the first prompt |
| `UserPromptSubmit`, `UserPromptExpansion` | Alongside the submitted prompt |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch` | Next to the tool result |

**Character limit:** 10,000 characters per context string. Excess → written to file in session dir, file path + preview passed to Claude.

**Content type:** delivered AS A SYSTEM REMINDER (not user message). Same category as stdout.

### SessionStart hookSpecificOutput (THE KEY DISCOVERY)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "context string",
    "initialUserMessage": "first message (SessionStart only)",
    "watchPaths": ["/path/to/watch1", "/path/to/watch2"]
  }
}
```

🎯 **`initialUserMessage` is a SessionStart-only field that becomes the first user message of the session.** This goes into `messages[]` as a real user-role turn, NOT a system reminder.

This is the unexplored angle for Throughline: instead of injecting context (system reminder = "briefing"), inject the resume context AS the first user message ("the user just said this, including past history") so the model treats it as actual conversation input.

### UserPromptSubmit hookSpecificOutput

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "context string",
    "sessionTitle": "auto-set session title"
  }
}
```

(No `initialUserMessage` — it only exists on SessionStart.)

---

## Hook output handling

| Exit Code | Meaning | JSON Processed? | Blocking? |
|---|---|---|---|
| **0** | Success | YES (if JSON present) | No |
| **2** | Blocking error | NO (JSON ignored) | Yes (event-dependent) |
| Other | Non-blocking error | NO | No |

### Stdout

| Event | stdout becomes Claude-visible? |
|---|---|
| `SessionStart` / `UserPromptSubmit` / `UserPromptExpansion` | YES (as system reminder) |
| Other events | NO (debug log only) |

### Resume / replay behavior

> Once injected, the text is saved in the session transcript. For mid-session events like `PostToolUse` or `UserPromptSubmit`, resuming with `--continue` or `--resume` replays the saved text rather than re-running the hook for past turns, so values like timestamps or commit SHAs become stale on resume. **`SessionStart` hooks run again on resume with `source` set to `"resume"`, so they can refresh their context.**

### JSON output fields (exit 0 only)

```json
{
  "continue": true,
  "stopReason": "message if continue is false",
  "suppressOutput": false,
  "systemMessage": "warning shown to user",
  "terminalSequence": "OSC escape sequence",
  "hookSpecificOutput": {
    "hookEventName": "EventName",
    "additionalContext": "..."
  }
}
```

| Field | Default | Effect |
|---|---|---|
| `continue` | `true` | If `false`, Claude stops processing entirely |
| `stopReason` | — | Message shown when `continue: false` |
| `suppressOutput` | `false` | Hide hook's stdout from transcript (still in debug log) |
| `systemMessage` | — | Warning shown to user |
| `terminalSequence` | — | OSC 0/1/2/9/99/777, BEL only |

### PreToolUse decision control (extra)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask|defer",
    "permissionDecisionReason": "explanation text",
    "additionalContext": "context for Claude",
    "updatedInput": { "command": "modified command" }
  }
}
```

`updatedInput` modifies tool parameters before execution. Note: only PreToolUse has `updatedInput`.

### When multiple hooks return additionalContext

> When several hooks return `additionalContext` for the same event, Claude receives all of the values.

---

## Transcript / messages[] construction (incompletely documented)

The docs do NOT detail how messages[] is constructed from JSONL. What we can infer:

1. Hook context = system reminders (not user/assistant messages)
2. Stdout = system reminders for SessionStart / UserPromptSubmit / UserPromptExpansion, log-only otherwise
3. Hook outputs are persisted in transcript and replayed on `--continue` / `--resume`
4. SessionStart re-runs on resume with `source: "resume"` (so it can refresh)
5. **`initialUserMessage`** appears to be the only documented way for a hook to inject a real user-role message

---

## Output method summary

| Method | Exit | Content Type | Visible to Claude? | Use Case |
|---|---|---|---|---|
| Plain stdout (SessionStart / UserPromptSubmit / UserPromptExpansion) | 0 | Text | YES (system reminder) | Quick context injection |
| Plain stdout (other) | 0 | Text | NO (debug log) | Logging only |
| Exit code 2 | 2 | stderr | YES (as error) | Policy enforcement |
| JSON `additionalContext` | 0 | JSON | YES (system reminder) | Structured context |
| **JSON `initialUserMessage` (SessionStart only)** | 0 | JSON | **YES (as user message!)** | **First user-role injection** |
| JSON `decision: "block"` | 0 | JSON | YES (decision reason) | Event-specific block |
| JSON `continue: false` | 0 | JSON | Halts session | Hard stop |
