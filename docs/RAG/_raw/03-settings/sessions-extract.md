# Claude Code Sessions — Extract

Source: <https://code.claude.com/docs/en/sessions> (fetched 2026-05-24)

## Session storage

- JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`
- `<project>` derived from working directory path
- Each line is a JSON object (message / tool use / metadata)
- Override storage location: `CLAUDE_CONFIG_DIR` env var
- Default retention: 30 days, configurable via `cleanupPeriodDays`
- Disable transcript writes: `CLAUDE_CODE_SKIP_PROMPT_HISTORY` (env), or `--no-session-persistence` (CLI flag)

## Resume / continue

| Command | Behavior |
|---|---|
| `claude --continue` | Resumes most recent session in current directory |
| `claude --resume` | Opens session picker |
| `claude --resume <name>` | Resumes named session directly |
| `claude --from-pr <number>` | Resumes session linked to PR |
| `/resume` (inside session) | Switches to a different conversation |

## /clear behavior (KEY)

> `/clear`: start fresh with an empty context. **The previous conversation is saved and resumable**.

- /clear empties CC's in-memory context buffer
- Previous conversation remains in JSONL, retrievable via `--continue` / `--resume`
- This implies CC has BOTH an in-memory state AND the persisted JSONL — and after /clear, the in-memory state is reset but the file is preserved

## /compact behavior

> `/compact [instructions]`: replace history with a summary, optionally focused on what you specify

- Summarizes existing context in-place
- Optionally focused via instructions
- Triggers `PreCompact` / `PostCompact` hooks (mid-session events)

## /context

> `/context`: show what is currently consuming context

## Branch / fork

> `/branch [name]` or `--fork-session` with `--continue` / `--resume`:
> Creates a copy of the conversation so far and switches into it, leaving the original intact.

- Permission grants don't carry over to new branch
- Resuming the same session in two terminals interleaves messages into one transcript

## Naming

- `claude -n <name>` (at startup)
- `/rename <name>` (mid-session)
- `Ctrl+R` in session picker
- Auto-naming on plan accept

## Implications for Throughline

1. **/clear preserves JSONL**. CC's in-memory state is the canonical source for the new session's messages[], NOT the JSONL.
2. **/compact preserves session continuity** — same session_id, just summarized. This is the documented "memory preservation" path.
3. **`--continue` / `--resume` are the official "restore from JSONL" mechanisms** but they pull the WHOLE prior conversation (no Throughline-style L1/L2/L3 selective compression).
4. **There's no documented hook to influence in-memory state after /clear**, only context attachments (system reminders).
