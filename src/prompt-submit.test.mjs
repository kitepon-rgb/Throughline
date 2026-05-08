import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBatonCommand, isClearCommand } from './prompt-submit.mjs';

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
