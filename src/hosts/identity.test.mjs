import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEX_SESSION_PREFIX,
  GROK_SESSION_PREFIX,
  NON_CLAUDE_SESSION_PREFIXES,
  buildCodexThroughlineSessionId,
  codexSessionIdToThreadId,
  grokBareSessionId,
  hostOfSessionId,
  isCodexSessionId,
  isGrokSessionId,
} from './identity.mjs';
import { hostAdapterForSessionId } from './index.mjs';

test('session prefixes are the canonical wire values', () => {
  assert.equal(CODEX_SESSION_PREFIX, 'codex:');
  assert.equal(GROK_SESSION_PREFIX, 'grok:');
  assert.deepEqual([...NON_CLAUDE_SESSION_PREFIXES], ['codex:', 'grok:']);
});

test('hostOfSessionId maps prefixes to hosts and defaults to claude', () => {
  assert.equal(hostOfSessionId('codex:0199aa'), 'codex');
  assert.equal(hostOfSessionId('grok:0199aa'), 'grok');
  assert.equal(hostOfSessionId('0199aa-claude'), 'claude');
  assert.equal(hostOfSessionId(undefined), 'claude');
});

test('codex session id round-trips thread id', () => {
  assert.equal(buildCodexThroughlineSessionId(' t1 '), 'codex:t1');
  assert.equal(codexSessionIdToThreadId('codex:t1'), 't1');
  assert.equal(codexSessionIdToThreadId('t1'), null);
  assert.equal(codexSessionIdToThreadId('codex:'), null);
  assert.throws(() => buildCodexThroughlineSessionId('  '));
});

test('grokBareSessionId strips only the grok prefix', () => {
  assert.equal(grokBareSessionId('grok:abc'), 'abc');
  assert.equal(grokBareSessionId('abc'), 'abc');
  assert.equal(grokBareSessionId(''), null);
});

test('isCodexSessionId / isGrokSessionId reject non-strings', () => {
  assert.equal(isCodexSessionId(null), false);
  assert.equal(isGrokSessionId(undefined), false);
});

test('every host adapter satisfies the shared hook contract', () => {
  for (const sessionId of ['claude-session', 'codex:t1', 'grok:t1']) {
    const adapter = hostAdapterForSessionId(sessionId);
    assert.equal(typeof adapter.host, 'string');
    assert.equal(adapter.matchesSessionId(sessionId), true);
    assert.equal(typeof adapter.waitsForStopTranscriptFlush, 'boolean');
    assert.equal(typeof adapter.deliverHandoffInjection, 'function');
    assert.equal(typeof adapter.resolveCommandPrompt, 'function');
    assert.equal(typeof adapter.afterBatonWrite, 'function');
  }
});

test('flush barrier applies to claude and codex sessions, not grok', () => {
  assert.equal(hostAdapterForSessionId('claude-session').waitsForStopTranscriptFlush, true);
  assert.equal(hostAdapterForSessionId('codex:t1').waitsForStopTranscriptFlush, true);
  assert.equal(hostAdapterForSessionId('grok:t1').waitsForStopTranscriptFlush, false);
});
