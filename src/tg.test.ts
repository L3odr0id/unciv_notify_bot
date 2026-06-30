import { test } from 'node:test';
import assert from 'node:assert';
import { code, esc } from './tg';

void test('code wraps a value in backticks', () => {
  assert.equal(code('d7af47a5-284a'), '`d7af47a5-284a`');
});

void test('esc escapes markdown specials', () => {
  assert.equal(esc('a_b*c[d]e`f'), 'a\\_b\\*c\\[d\\]e\\`f');
});

void test('esc leaves clean text untouched', () => {
  assert.equal(esc('The Ottomans'), 'The Ottomans');
});
