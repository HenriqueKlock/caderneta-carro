import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginEmailError } from '../src/auth-errors.ts';

test('limite de e-mails do projeto', () => {
  assert.match(loginEmailError('email rate limit exceeded'), /até uma hora/);
});
test('intervalo por usuário', () => {
  assert.match(loginEmailError('For security purposes, you can only request this after 37 seconds.'), /37 segundos/);
});
test('outras mensagens passam direto', () => {
  assert.equal(loginEmailError('Signups not allowed'), 'Signups not allowed');
});
