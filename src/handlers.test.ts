import { test } from 'node:test';
import assert from 'node:assert';
import { openDb, listSubscriptions, getSetting, adminChatIds } from './db';
import { GamePreview } from './unciv';
import { GameNotFound } from './unciv';
import {
  normalizeUsername,
  parseAdminSet,
  parseRegister,
  handleMessage,
  HandlerDeps,
} from './handlers';
import { setLevel } from './log';
setLevel('silent');

test('normalizeUsername strips @ and lowercases', () => {
  assert.equal(normalizeUsername('@Alice'), 'alice');
  assert.equal(normalizeUsername(' BOB '), 'bob');
});

test('parseAdminSet splits and normalizes', () => {
  const s = parseAdminSet('@Alice, bob ,');
  assert.deepEqual([...s].sort(), ['alice', 'bob']);
});

test('parseRegister extracts game and user', () => {
  assert.deepEqual(parseRegister('Game: abc User: xyz'), { gameId: 'abc', userId: 'xyz' });
  assert.equal(parseRegister('hello'), null);
});

function deps(over: Partial<HandlerDeps> = {}): { deps: HandlerDeps; out: string[] } {
  const out: string[] = [];
  const preview: GamePreview = {
    turns: 1,
    currentPlayer: 'civ1',
    civilizations: [{ civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human' }],
  };
  return {
    out,
    deps: {
      db: openDb(':memory:'),
      adminSet: new Set(),
      fetchPreview: async () => preview,
      reply: async (t) => {
        out.push(t);
      },
      ...over,
    },
  };
}

test('register valid user adds subscription and confirms', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, text: 'Game: g1 User: uA' });
  assert.equal(listSubscriptions(d.db, 1).length, 1);
  assert.match(out[0], /subscribed/i);
});

test('register rejects user not in game', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, text: 'Game: g1 User: nobody' });
  assert.equal(listSubscriptions(d.db, 1).length, 0);
  assert.match(out[0], /not a player/i);
});

test('register reports game not found', async () => {
  const { deps: d, out } = deps({
    fetchPreview: async () => {
      throw new GameNotFound('g1');
    },
  });
  await handleMessage(d, { chatId: 1, text: 'Game: g1 User: uA' });
  assert.match(out[0], /not found/i);
});

test('unknown text returns usage', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, text: 'blah' });
  assert.match(out[0], /Game:/);
});

test('/list shows subscriptions', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, text: 'Game: g1 User: uA' });
  await handleMessage(d, { chatId: 1, text: '/list' });
  assert.match(out[1], /g1/);
});

test('/unsubscribe removes', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, text: 'Game: g1 User: uA' });
  await handleMessage(d, { chatId: 1, text: '/unsubscribe g1' });
  assert.equal(listSubscriptions(d.db, 1).length, 0);
  assert.match(out[1], /removed/i);
});

test('admin message learns chat_id', async () => {
  const { deps: d } = deps({ adminSet: new Set(['alice']) });
  await handleMessage(d, { chatId: 555, username: '@Alice', text: '/list' });
  assert.deepEqual(adminChatIds(d.db), [555]);
});

test('/setinterval persists for admin and is rejected for non-admin', async () => {
  const { deps: d, out } = deps({ adminSet: new Set(['alice']) });
  await handleMessage(d, { chatId: 9, username: 'eve', text: '/setinterval 20' });
  assert.equal(getSetting(d.db, 'poll_interval_seconds'), undefined);
  assert.match(out[0], /admin/i);
  await handleMessage(d, { chatId: 555, username: 'alice', text: '/setinterval 20' });
  assert.equal(getSetting(d.db, 'poll_interval_seconds'), '20');
});

test('/setinterval rejects below minimum', async () => {
  const { deps: d, out } = deps({ adminSet: new Set(['alice']) });
  await handleMessage(d, { chatId: 555, username: 'alice', text: '/setinterval 5' });
  assert.equal(getSetting(d.db, 'poll_interval_seconds'), undefined);
  assert.match(out[0], /at least 10/i);
});

test('/stats for admin returns counts', async () => {
  const { deps: d, out } = deps({ adminSet: new Set(['alice']) });
  await handleMessage(d, { chatId: 555, username: 'alice', text: '/stats' });
  assert.match(out[0], /games/i);
});
