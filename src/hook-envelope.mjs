// Grok sends Claude-compatible hook commands with a camelCase wire
// (sessionId, hookEventName) and no session_id. Throughline treats that
// envelope as host=grok: normalize to the Claude snake_case contract and
// prefix session ids so they never mix with Claude predecessor search.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const GROK_SESSION_PREFIX = 'grok:';

export function isGrokEnvelope(payload) {
  return payload !== null
    && typeof payload === 'object'
    && typeof payload.sessionId === 'string'
    && payload.sessionId.length > 0
    && typeof payload.hookEventName === 'string'
    && payload.hookEventName.length > 0
    && !Object.hasOwn(payload, 'session_id');
}

export function grokBareSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  return sessionId.startsWith(GROK_SESSION_PREFIX)
    ? sessionId.slice(GROK_SESSION_PREFIX.length)
    : sessionId;
}

export function deriveGrokChatHistoryPath(projectPath, sessionId, { home = homedir() } = {}) {
  const bare = grokBareSessionId(sessionId);
  if (!projectPath || !bare) return null;
  return join(home, '.grok', 'sessions', encodeURIComponent(projectPath), bare, 'chat_history.jsonl');
}

export function normalizeHookPayload(payload, { home = homedir() } = {}) {
  if (!isGrokEnvelope(payload)) return payload;
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0
    ? payload.cwd
    : (typeof payload.workspaceRoot === 'string' ? payload.workspaceRoot : undefined);
  const transcriptPath = typeof payload.transcriptPath === 'string' && payload.transcriptPath.length > 0
    ? payload.transcriptPath
    : deriveGrokChatHistoryPath(cwd, payload.sessionId, { home });
  return {
    ...payload,
    session_id: `${GROK_SESSION_PREFIX}${payload.sessionId}`,
    cwd,
    source: payload.source,
    prompt: payload.prompt,
    hook_event_name: payload.hookEventName,
    transcript_path: transcriptPath,
    last_assistant_message: payload.lastAssistantMessage,
  };
}
