import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandTextFromPrompt,
  isBatonCommand,
  isClearCommand,
} from './prompt-submit.mjs';
import { hostAdapterForSessionId } from './hosts/index.mjs';

test('isBatonCommand: bare /tl', () => {
  assert.equal(isBatonCommand('/tl'), true);
});

test('isBatonCommand: /tl with trailing newline', () => {
  assert.equal(isBatonCommand('/tl\n'), true);
});

test('isBatonCommand: /tl with leading/trailing whitespace', () => {
  assert.equal(isBatonCommand('  /tl  '), true);
});

test('isBatonCommand: /tl with arguments', () => {
  assert.equal(isBatonCommand('/tl some memo'), true);
});

test('isBatonCommand: rejects /tl-prefixed identifier', () => {
  assert.equal(isBatonCommand('/tldr summary'), false);
});

test('isBatonCommand: rejects /clear', () => {
  assert.equal(isBatonCommand('/clear'), false);
});

test('isBatonCommand: rejects empty / non-string', () => {
  assert.equal(isBatonCommand(''), false);
  assert.equal(isBatonCommand(null), false);
  assert.equal(isBatonCommand(undefined), false);
  assert.equal(isBatonCommand(42), false);
});

test('isClearCommand: bare /clear', () => {
  assert.equal(isClearCommand('/clear'), true);
});

test('isClearCommand: /clear with trailing newline', () => {
  assert.equal(isClearCommand('/clear\n'), true);
});

test('isClearCommand: /clear with leading/trailing whitespace', () => {
  assert.equal(isClearCommand('  /clear  '), true);
});

test('isClearCommand: /clear with arguments', () => {
  assert.equal(isClearCommand('/clear something'), true);
});

test('isClearCommand: rejects /clear-prefixed identifier', () => {
  assert.equal(isClearCommand('/cleared'), false);
  assert.equal(isClearCommand('/clearcache'), false);
});

test('isClearCommand: rejects /tl', () => {
  assert.equal(isClearCommand('/tl'), false);
});

test('isClearCommand: rejects empty / non-string', () => {
  assert.equal(isClearCommand(''), false);
  assert.equal(isClearCommand(null), false);
  assert.equal(isClearCommand(undefined), false);
  assert.equal(isClearCommand(42), false);
});

test('commandTextFromPrompt unwraps Grok user_query and leaves bare Claude text', () => {
  assert.equal(commandTextFromPrompt('/tl'), '/tl');
  assert.equal(
    commandTextFromPrompt('<user_query>\n/tl\n</user_query>\n<skill_information>saved</skill_information>'),
    '/tl',
  );
});

test('afterBatonWrite launches grok-continue only for Grok /tl', () => {
  const noLaunch = () => {
    throw new Error('must not launch');
  };
  assert.deepEqual(
    hostAdapterForSessionId('grok:abc').afterBatonWrite({
      trigger: 'clear', sessionId: 'grok:abc', cwd: '/work', continueRun: noLaunch,
    }),
    { launched: false },
  );
  assert.deepEqual(
    hostAdapterForSessionId('old-session').afterBatonWrite({
      trigger: 'tl', sessionId: 'old-session', cwd: '/work', continueRun: noLaunch,
    }),
    { launched: false },
  );
  assert.deepEqual(
    hostAdapterForSessionId('codex:thread').afterBatonWrite({
      trigger: 'tl', sessionId: 'codex:thread', cwd: '/work', continueRun: noLaunch,
    }),
    { launched: false },
  );
});

test('Grok afterBatonWrite calls grok-continue with the source session', () => {
  const calls = [];
  const result = hostAdapterForSessionId('grok:abc').afterBatonWrite({
    trigger: 'tl',
    sessionId: 'grok:abc',
    cwd: '/work/Throughline',
    continueRun: (argv, opts) => {
      calls.push({ argv, opts });
      return 0;
    },
  });
  assert.deepEqual(result, { launched: true, exitCode: 0 });
  assert.deepEqual(calls, [{
    argv: ['--session', 'grok:abc'],
    opts: { cwd: '/work/Throughline' },
  }]);
});

test('isBatonCommand: Grok user_query wrap around /tl', () => {
  const wrapped =
    '<user_query>\n/tl\n</user_query>\n<skill_information>\nThroughline saved the baton.\n</skill_information>';
  assert.equal(isBatonCommand(wrapped), true);
});

test('isBatonCommand: Grok wrap does not treat skill body /tl as the command', () => {
  const wrapped =
    '<user_query>\n続けてくれ\n</user_query>\n<skill_information>\nType /tl to hand off.\n</skill_information>';
  assert.equal(isBatonCommand(wrapped), false);
});

test('isClearCommand: Grok user_query wrap around /clear and /new', () => {
  assert.equal(isClearCommand('<user_query>\n/clear\n</user_query>'), true);
  assert.equal(isClearCommand('<user_query>\n/new\n</user_query>'), true);
  assert.equal(isClearCommand('/new'), true);
  assert.equal(isClearCommand('/newest'), false);
});
