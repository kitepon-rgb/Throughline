// Grok can invoke Claude-compatible hook commands with its camelCase wire.
// Throughline does not support Grok as a host, so this envelope is ignored
// before DB, state, VS Code task, transcript, or runtime-error side effects.
export function isUnsupportedNonClaudeEnvelope(payload) {
  return payload !== null
    && typeof payload === 'object'
    && typeof payload.sessionId === 'string'
    && payload.sessionId.length > 0
    && typeof payload.hookEventName === 'string'
    && payload.hookEventName.length > 0
    && !Object.hasOwn(payload, 'session_id');
}
