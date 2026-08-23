import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  deriveGrokChatHistoryPath,
  isGrokEnvelope,
  normalizeHookPayload,
} from './index.mjs';

test('isGrokEnvelope detects camelCase wire without session_id', () => {
  assert.equal(
    isGrokEnvelope({
      sessionId: '01a00aa2-dead-beef',
      hookEventName: 'session_start',
      cwd: '/tmp/proj',
    }),
    true,
  );
  assert.equal(
    isGrokEnvelope({
      session_id: 'claude-session',
      hook_event_name: 'SessionStart',
    }),
    false,
  );
});

test('normalizeHookPayload prefixes grok: and derives chat_history path', () => {
  const home = '/tmp/tl-home';
  const cwd = '/Users/kite/Developer/dotagents';
  const payload = normalizeHookPayload(
    {
      sessionId: '01a00aa2-dead-beef',
      hookEventName: 'user_prompt_submit',
      cwd,
      prompt: 'hello',
      lastAssistantMessage: 'hi',
    },
    { home },
  );
  assert.equal(payload.session_id, 'grok:01a00aa2-dead-beef');
  assert.equal(payload.prompt, 'hello');
  assert.equal(payload.last_assistant_message, 'hi');
  assert.equal(
    payload.transcript_path,
    join(home, '.grok', 'sessions', encodeURIComponent(cwd), '01a00aa2-dead-beef', 'chat_history.jsonl'),
  );
  assert.equal(
    deriveGrokChatHistoryPath(cwd, 'grok:01a00aa2-dead-beef', { home }),
    payload.transcript_path,
  );
});

test('normalizeHookPayload ignores Grok transcriptPath pointing at updates.jsonl', () => {
  const home = '/tmp/tl-home';
  const cwd = '/Users/kite/Developer/dotagents';
  const sessionId = '01a00b38-87ea-7670-8f7d-a9fe937263c5';
  const payload = normalizeHookPayload(
    {
      sessionId,
      hookEventName: 'stop',
      cwd,
      transcriptPath: join(
        home,
        '.grok',
        'sessions',
        encodeURIComponent(cwd),
        sessionId,
        'updates.jsonl',
      ),
    },
    { home },
  );
  assert.equal(
    payload.transcript_path,
    join(home, '.grok', 'sessions', encodeURIComponent(cwd), sessionId, 'chat_history.jsonl'),
  );
});
