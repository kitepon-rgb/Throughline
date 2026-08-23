/**
 * hosts/claude.mjs — Claude host adapter
 *
 * Claude は Throughline の基準 host。hook payload は snake_case のまま届き、
 * 引き継ぎ注入は UserPromptSubmit hook の stdout でモデルへ渡る。
 */
import { CLAUDE_HOST, hostOfSessionId } from './identity.mjs';

export const claudeHostAdapter = Object.freeze({
  host: CLAUDE_HOST,
  matchesSessionId: (sessionId) => hostOfSessionId(sessionId) === CLAUDE_HOST,
  // Claude Stop payload の last_assistant_message を transcript 可視化の
  // barrier に使う (ADR 0012)。
  waitsForStopTranscriptFlush: true,
  // Claude は UserPromptSubmit stdout がそのままモデル可視 context になる。
  deliverHandoffInjection({ text, stdout = process.stdout }) {
    stdout.write(text + '\n');
    return { delivered: true };
  },
  // Claude の prompt は裸の slash command がそのまま届く。
  resolveCommandPrompt({ prompt }) {
    return prompt;
  },
  afterBatonWrite() {
    return { launched: false };
  },
});
