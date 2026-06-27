import { test } from 'node:test';
import assert from 'node:assert';
import { openDb, setSetting } from './db';
import { resolveIntervalMs } from './index';
import { setLevel } from './log';
setLevel('silent');

void test('resolveIntervalMs uses fallback when unset', () => {
  const db = openDb(':memory:');
  assert.equal(resolveIntervalMs(db, 60), 60_000);
});

void test('resolveIntervalMs uses stored setting', () => {
  const db = openDb(':memory:');
  setSetting(db, 'poll_interval_seconds', '30');
  assert.equal(resolveIntervalMs(db, 60), 30_000);
});

void test('resolveIntervalMs floors at minimum', () => {
  const db = openDb(':memory:');
  setSetting(db, 'poll_interval_seconds', '2');
  assert.equal(resolveIntervalMs(db, 60), 10_000);
});

void test('resolveIntervalMs floors even when stored value is non-numeric', () => {
  const db = openDb(':memory:');
  setSetting(db, 'poll_interval_seconds', 'garbage');
  assert.equal(resolveIntervalMs(db, 5), 10_000);
});
