import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openDb,
  addSubscription,
  removeSubscription,
  listSubscriptions,
  distinctGameIds,
  subscribersForGame,
  getGameState,
  setGameState,
  deleteGame,
  upsertAdmin,
  adminChatIds,
  getSetting,
  setSetting,
  stats,
} from './db';

test('subscriptions add/list/dedup', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA');
  addSubscription(db, 1, 'g1', 'uA'); // duplicate ignored
  addSubscription(db, 1, 'g2', 'uB');
  assert.equal(listSubscriptions(db, 1).length, 2);
  assert.deepEqual(distinctGameIds(db).sort(), ['g1', 'g2']);
});

test('subscribersForGame returns chat+user', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA');
  addSubscription(db, 2, 'g1', 'uB');
  const subs = subscribersForGame(db, 'g1');
  assert.equal(subs.length, 2);
});

test('removeSubscription by game removes all users for that game/chat', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA');
  addSubscription(db, 1, 'g1', 'uB');
  const removed = removeSubscription(db, 1, 'g1');
  assert.equal(removed, 2);
  assert.equal(listSubscriptions(db, 1).length, 0);
});

test('removeSubscription with userId removes one', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA');
  addSubscription(db, 1, 'g1', 'uB');
  assert.equal(removeSubscription(db, 1, 'g1', 'uA'), 1);
  assert.equal(listSubscriptions(db, 1).length, 1);
});

test('game_state get/set/delete', () => {
  const db = openDb(':memory:');
  assert.equal(getGameState(db, 'g1'), undefined);
  setGameState(db, 'g1', 5, 'civ1');
  assert.deepEqual(getGameState(db, 'g1'), { last_turns: 5, last_current_player: 'civ1' });
  setGameState(db, 'g1', 6, 'civ2');
  assert.deepEqual(getGameState(db, 'g1'), { last_turns: 6, last_current_player: 'civ2' });
});

test('deleteGame removes subs and state', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA');
  setGameState(db, 'g1', 5, 'civ1');
  deleteGame(db, 'g1');
  assert.equal(distinctGameIds(db).length, 0);
  assert.equal(getGameState(db, 'g1'), undefined);
});

test('removeSubscription with empty-string userId removes only that row', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', '');
  addSubscription(db, 1, 'g1', 'uB');
  assert.equal(removeSubscription(db, 1, 'g1', ''), 1);
  assert.equal(listSubscriptions(db, 1).length, 1);
});

test('admins upsert learns and updates chat_id', () => {
  const db = openDb(':memory:');
  upsertAdmin(db, 'alice', 100);
  upsertAdmin(db, 'alice', 101); // re-contact, new chat
  upsertAdmin(db, 'bob', 200);
  assert.deepEqual(adminChatIds(db).sort((a, b) => a - b), [101, 200]);
});

test('settings get/set', () => {
  const db = openDb(':memory:');
  assert.equal(getSetting(db, 'poll_interval_seconds'), undefined);
  setSetting(db, 'poll_interval_seconds', '30');
  assert.equal(getSetting(db, 'poll_interval_seconds'), '30');
});

test('stats counts distinct games, subs, admins', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA');
  addSubscription(db, 2, 'g1', 'uB');
  addSubscription(db, 1, 'g2', 'uA');
  upsertAdmin(db, 'alice', 100);
  assert.deepEqual(stats(db), { games: 2, subs: 3, admins: 1 });
});

test('openDb creates a missing nested parent directory and the db file', () => {
  const root = join(tmpdir(), `uncivbot-test-${process.pid}-${Date.now()}`);
  const dbPath = join(root, 'nested', 'subscriptions.db');
  let db;
  try {
    db = openDb(dbPath);
    assert.ok(existsSync(dbPath), 'db file should exist');
  } finally {
    if (db) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('openDb still works with :memory:', () => {
  const db = openDb(':memory:');
  assert.ok(db);
  db.close();
});
