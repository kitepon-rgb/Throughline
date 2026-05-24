# Anthropic Messages API — Extract

Source: <https://platform.claude.com/docs/en/api/messages> (fetched 2026-05-24)

## Messages array structure

### Role values

Only `"user"` and `"assistant"`. No `"system"` role in messages[].

> "Our models are trained to operate on alternating `user` and `assistant` conversational turns."

> "Consecutive `user` or `assistant` turns in your request will be combined into a single turn."

### Content block types

Each message's `content` is either a string (shorthand for `[{"type": "text", "text": "..."}]`) or an array of `ContentBlockParam`.

| Type | Schema | Purpose |
|---|---|---|
| `text` | `{type: "text", text, cache_control?, citations?}` | Plain text |
| `image` | `{type: "image", source, cache_control?}` | Images |
| `document` | `{type: "document", source, title?, context?, citations?, cache_control?}` | PDF / plain text |
| `tool_use` | `{type: "tool_use", id, name, input, caller?, cache_control?}` | Model's tool invocation |
| `tool_result` | `{type: "tool_result", tool_use_id, content?, is_error?, cache_control?}` | Tool execution result |
| `thinking` | `{type: "thinking", thinking, signature}` | Extended thinking (input only) |
| `redacted_thinking` | `{type: "redacted_thinking", data}` | Redacted thinking |
| `search_result` | `{type: "search_result", title, source, content, cache_control?, citations?}` | Web search results |
| `server_tool_use` | `{type: "server_tool_use", id, name, input, caller?, cache_control?}` | Server-side tool execution |

---

## System field (top-level)

```json
{
  "system": "You are a helpful assistant.",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

> "Note that if you want to include a system prompt, you can use the top-level `system` parameter — there is no `system` role for input messages in the Messages API."

`system` accepts string OR `TextBlockParam[]`:

```json
{
  "system": [
    {"type": "text", "text": "Today's date is 2024-06-01.",
     "cache_control": {"type": "ephemeral", "ttl": "5m"}}
  ]
}
```

---

## Conversation continuation & synthetic messages (CRITICAL FOR THROUGHLINE)

### Synthetic assistant prefill

> "If the final message uses the `assistant` role, the response content will continue immediately from the content in that message. This can be used to constrain part of the model's response."

Example:

```json
{
  "messages": [
    {"role": "user", "content": "What's the Greek name for Sun? (A) Sol (B) Helios (C) Sun"},
    {"role": "assistant", "content": "The best answer is ("}
  ]
}
```

Response: model continues from `"The best answer is ("` and outputs `"B)"`.

### No differentiation between real & synthetic messages (KEY)

> "When creating a new `Message`, you specify the prior conversational turns with the `messages` parameter, and the model then generates the next `Message` in the conversation."

**The documentation does not distinguish between:**

- Historically real messages from past API calls
- Newly constructed/injected synthetic messages in the current request

→ Models treat all messages equally regardless of source. **No metadata field indicates whether a message was real or synthetic.**

This validates the D-route theory: IF we could inject prior turns into messages[], the model would treat them as continuation. The question is purely about **how to control messages[] from within Claude Code**.

### Turn combining

> "Consecutive `user` or `assistant` turns in your request will be combined into a single turn."

This applies uniformly regardless of source.

---

## Fields outside messages[]

Top-level request parameters (relevant for context):

| Parameter | Type | Purpose |
|---|---|---|
| `system` | `string \| TextBlockParam[]` | System prompt |
| `model` | `string` | Required |
| `max_tokens` | `number` | Required |
| `temperature`, `top_p`, `top_k`, `stop_sequences` | — | sampling |
| `tools`, `tool_choice` | — | Tool definitions |
| `thinking` | `ThinkingConfig` | Extended thinking budget |
| `stream` | `boolean` | Streaming |
| `metadata` | `{user_id?}` | Request tracking |
| `cache_control` | `CacheControlEphemeral` | Top-level cache marker |
| `service_tier` | `"auto" \| "standard_only"` | Capacity tier |
| `output_config` | `{format?, effort?}` | Output formatting |

No "transcript" or "session_history" field — all conversation context goes through `messages[]` or `system`.

---

## Implications for Throughline

1. **Only `messages[]` carries "real" conversation history**. `system` is briefing material.
2. **The model treats all `messages[]` entries equally** — synthetic past turns are indistinguishable from real ones.
3. **For "本人体感" (the assistant feeling like it was the one talking), the past turns MUST be in `messages[]`, not in `system`.**
4. **Synthetic assistant prefill is officially supported** — we could end messages[] with an assistant turn to constrain continuation.

→ Claude Code's challenge: how does CC build the API request's `messages[]`? If we can influence that (via `initialUserMessage` or another mechanism), we can solve the "本人体感" problem.
