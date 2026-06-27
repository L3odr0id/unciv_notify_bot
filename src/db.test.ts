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
  allSubscriptions,
  blockUsername,
  blockChat,
  unblockUsername,
  unblockChat,
  isBlocked,
  removeByChat,
  removeByUsername,
} from './db';

void test('subscriptions add/list/dedup', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA');
  addSubscription(db, 1, 'g1', 'uA'); // duplicate ignored
  addSubscription(db, 1, 'g2', 'uB');
  assert.equal(listSubscriptions(db, 1).length, 2);
  assert.deepEqual(distinctGameIds(db).sort(), ['g1', 'g2']);
});

void test('subscribersForGame returns chat+user', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA');
  addSubscription(db, 2, 'g1', 'uB');
  const subs = subscribersForGame(db, 'g1');
  assert.equal(subs.length, 2);
});

void test('removeSubscription by game removes all users for that game/chat', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA');
  addSubscription(db, 1, 'g1', 'uB');
  const removed = removeSubscription(db, 1, 'g1');
  assert.equal(removed, 2);
  assert.equal(listSubscriptions(db, 1).length, 0);
});

void test('removeSubscription with userId removes one', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA');
  addSubscription(db, 1, 'g1', 'uB');
  assert.equal(removeSubscription(db, 1, 'g1', 'uA'), 1);
  assert.equal(listSubscriptions(db, 1).length, 1);
});

void test('game_state get/set/delete', () => {
  const db = openDb(':memory:');
  assert.equal(getGameState(db, 'g1'), undefined);
  setGameState(db, 'g1', 5, 'civ1');
  assert.deepEqual(getGameState(db, 'g1'), { last_turns: 5, last_current_player: 'civ1' });
  setGameState(db, 'g1', 6, 'civ2');
  assert.deepEqual(getGameState(db, 'g1'), { last_turns: 6, last_current_player: 'civ2' });
});

void test('deleteGame removes subs and state', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA');
  setGameState(db, 'g1', 5, 'civ1');
  deleteGame(db, 'g1');
  assert.equal(distinctGameIds(db).length, 0);
  assert.equal(getGameState(db, 'g1'), undefined);
});

void test('removeSubscription with empty-string userId removes only that row', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', '');
  addSubscription(db, 1, 'g1', 'uB');
  assert.equal(removeSubscription(db, 1, 'g1', ''), 1);
  assert.equal(listSubscriptions(db, 1).length, 1);
});

void test('admins upsert learns and updates chat_id', () => {
  const db = openDb(':memory:');
  upsertAdmin(db, 'alice', 100);
  upsertAdmin(db, 'alice', 101); // re-contact, new chat
  upsertAdmin(db, 'bob', 200);
  assert.deepEqual(adminChatIds(db).sort((a, b) => a - b), [101, 200]);
});

void test('settings get/set', () => {
  const db = openDb(':memory:');
  assert.equal(getSetting(db, 'poll_interval_seconds'), undefined);
  setSetting(db, 'poll_interval_seconds', '30');
  assert.equal(getSetting(db, 'poll_interval_seconds'), '30');
});

void test('stats counts distinct games, subs, admins', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA');
  addSubscription(db, 2, 'g1', 'uB');
  addSubscription(db, 1, 'g2', 'uA');
  upsertAdmin(db, 'alice', 100);
  assert.deepEqual(stats(db), { games: 2, subs: 3, admins: 1 });
});

void test('openDb creates a missing nested parent directory and the db file', () => {
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

void test('openDb still works with :memory:', () => {
  const db = openDb(':memory:');
  assert.ok(db);
  db.close();
});

void test('addSubscription stores username and refreshes it on conflict', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA', 'alice');
  addSubscription(db, 1, 'g1', 'uA', 'alice2'); // same PK → username updates
  const rows = allSubscriptions(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].username, 'alice2');
});

void test('addSubscription defaults username to empty string', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA');
  assert.equal(allSubscriptions(db)[0].username, '');
});

void test('allSubscriptions returns all rows ordered by chat,game', () => {
  const db = openDb(':memory:');
  addSubscription(db, 2, 'gB', 'uX', 'bob');
  addSubscription(db, 1, 'gA', 'uY', 'amy');
  const rows = allSubscriptions(db);
  assert.deepEqual(
    rows.map((r) => [r.chat_id, r.game_id]),
    [[1, 'gA'], [2, 'gB']],
  );
});

void test('blockUsername + isBlocked by username', () => {
  const db = openDb(':memory:');
  assert.equal(isBlocked(db, 99, 'spammer'), false);
  blockUsername(db, 'spammer');
  assert.equal(isBlocked(db, 99, 'spammer'), true);
  assert.equal(isBlocked(db, 99, 'someone'), false);
});

void test('blockChat + isBlocked by chat id', () => {
  const db = openDb(':memory:');
  blockChat(db, 42);
  assert.equal(isBlocked(db, 42, ''), true);
  assert.equal(isBlocked(db, 7, ''), false);
});

void test('unblock returns changes count', () => {
  const db = openDb(':memory:');
  blockUsername(db, 'spammer');
  assert.equal(unblockUsername(db, 'spammer'), 1);
  assert.equal(unblockUsername(db, 'spammer'), 0);
  blockChat(db, 42);
  assert.equal(unblockChat(db, 42), 1);
});

void test('removeByChat / removeByUsername delete subs and return count', () => {
  const db = openDb(':memory:');
  addSubscription(db, 1, 'g1', 'uA', 'bob');
  addSubscription(db, 1, 'g2', 'uB', 'bob');
  addSubscription(db, 2, 'g1', 'uC', 'amy');
  assert.equal(removeByChat(db, 1), 2);
  assert.equal(removeByUsername(db, 'amy'), 1);
  assert.equal(allSubscriptions(db).length, 0);
});
