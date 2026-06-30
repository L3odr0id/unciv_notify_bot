import { test } from 'node:test';
import assert from 'node:assert';
import { openDb, listSubscriptions, getSetting, setSetting, adminChatIds } from './db';
import { GamePreview } from './unciv';
import { GameNotFound, formatDuration } from './unciv';
import { SendOpts } from './tg';
import {
  normalizeUsername,
  parseAdminSet,
  handleMessage,
  HandlerDeps,
} from './handlers';
import { setLevel } from './log';
setLevel('silent');

void test('normalizeUsername strips @ and lowercases', () => {
  assert.equal(normalizeUsername('@Alice'), 'alice');
  assert.equal(normalizeUsername(' BOB '), 'bob');
});

void test('parseAdminSet splits and normalizes', () => {
  const s = parseAdminSet('@Alice, bob ,');
  assert.deepEqual([...s].sort(), ['alice', 'bob']);
});

void test('formatDuration short forms', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(5 * 60000), '5m');
  assert.equal(formatDuration(2 * 3600000), '2h');
  assert.equal(formatDuration(3 * 86400000 + 4 * 3600000), '3d 4h');
});

function deps(over: Partial<HandlerDeps> = {}): { deps: HandlerDeps; out: string[]; opts: (SendOpts | undefined)[] } {
  const out: string[] = [];
  const opts: (SendOpts | undefined)[] = [];
  const preview: GamePreview = {
    turns: 1,
    currentPlayer: 'civ1',
    currentTurnStartTime: 1000,
    gameParameters: { minutesUntilSkipTurn: 90, minutesUntilForceResign: 4320, minutesRecoveredPerTurn: 0 },
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 60 },
    ],
  };
  return {
    out,
    opts,
    deps: {
      db: openDb(':memory:'),
      adminSet: new Set(),
      fallbackIntervalSeconds: 60,
      now: () => 1000 + 30 * 60000, // 30 min into the turn
      fetchPreview: () => Promise.resolve(preview),
      reply: (t, o) => {
        out.push(t);
        opts.push(o);
        return Promise.resolve();
      },
      ...over,
    },
  };
}

void test('/subscribe adds subscription and confirms', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, text: '/subscribe g1 uA' });
  assert.equal(listSubscriptions(d.db, 1).length, 1);
  assert.match(out[0], /subscribed/i);
});

void test('/subscribe without args shows usage', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, text: '/subscribe g1' });
  assert.equal(listSubscriptions(d.db, 1).length, 0);
  assert.match(out[0], /usage: \/subscribe/i);
});

void test('/subscribe rejects user not in game', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, text: '/subscribe g1 nobody' });
  assert.equal(listSubscriptions(d.db, 1).length, 0);
  assert.match(out[0], /not a player/i);
});

void test('register reports game not found', async () => {
  const { deps: d, out } = deps({
    fetchPreview: () => Promise.reject(new GameNotFound('g1')),
  });
  await handleMessage(d, { chatId: 1, text: '/subscribe g1 uA' });
  assert.match(out[0], /not found/i);
});

void test('unknown text returns usage', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, text: 'blah' });
  assert.match(out[0], /\/subscribe/);
});

void test('/unsubscribe removes', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, text: '/subscribe g1 uA' });
  await handleMessage(d, { chatId: 1, text: '/unsubscribe g1' });
  assert.equal(listSubscriptions(d.db, 1).length, 0);
  assert.match(out[1], /removed/i);
});

void test('admin message learns chat_id', async () => {
  const { deps: d } = deps({ adminSet: new Set(['alice']) });
  await handleMessage(d, { chatId: 555, username: '@Alice', text: '/help' });
  assert.deepEqual(adminChatIds(d.db), [555]);
});

void test('/setinterval persists for admin and is rejected for non-admin', async () => {
  const { deps: d, out } = deps({ adminSet: new Set(['alice']) });
  await handleMessage(d, { chatId: 9, username: 'eve', text: '/setinterval 20' });
  assert.equal(getSetting(d.db, 'poll_interval_seconds'), undefined);
  assert.match(out[0], /admin/i);
  await handleMessage(d, { chatId: 555, username: 'alice', text: '/setinterval 20' });
  assert.equal(getSetting(d.db, 'poll_interval_seconds'), '20');
});

void test('/getinterval returns fallback when unset, then stored value', async () => {
  const { deps: d, out } = deps({ fallbackIntervalSeconds: 45 });
  await handleMessage(d, { chatId: 1, text: '/getinterval' });
  assert.match(out[0], /45s/);
  setSetting(d.db, 'poll_interval_seconds', '20');
  await handleMessage(d, { chatId: 1, text: '/getinterval' });
  assert.match(out[1], /20s/);
});

void test('/setinterval rejects below minimum', async () => {
  const { deps: d, out } = deps({ adminSet: new Set(['alice']) });
  await handleMessage(d, { chatId: 555, username: 'alice', text: '/setinterval 5' });
  assert.equal(getSetting(d.db, 'poll_interval_seconds'), undefined);
  assert.match(out[0], /at least 10/i);
});

void test('/stats for admin returns counts', async () => {
  const { deps: d, out } = deps({ adminSet: new Set(['alice']) });
  await handleMessage(d, { chatId: 555, username: 'alice', text: '/stats' });
  assert.match(out[0], /games/i);
});

void test('/list with no subscriptions', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, text: '/list' });
  assert.match(out[0], /no subscriptions/i);
});

void test('/list shows civ name, player id, started and deadline', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, text: '/subscribe g1 uA' });
  out.length = 0;
  await handleMessage(d, { chatId: 1, text: '/list' });
  assert.match(
    out[0],
    /Game `g1`\nTurn 1\nRome's turn - started 30m ago\.\n {3}⏭ Skip in: 1h\n {3}⏳ Kick in: 30m\nYou: Rome/,
  );
});

void test('/list reports finished game on 404', async () => {
  const fetchPreview = () => Promise.reject(new GameNotFound('g1'));
  const { deps: d, out } = deps({ fetchPreview });
  // subscribe directly via db so the failing fetch is only exercised by /list
  const { addSubscription } = await import('./db');
  addSubscription(d.db, 1, 'g1', 'uA', '');
  await handleMessage(d, { chatId: 1, text: '/list' });
  assert.match(out[0], /Game `g1`\nFinished or deleted\./);
});

void test('/list reports unreachable server on other error', async () => {
  const fetchPreview = () => Promise.reject(new Error('boom'));
  const { deps: d, out } = deps({ fetchPreview });
  const { addSubscription } = await import('./db');
  addSubscription(d.db, 1, 'g1', 'uA', '');
  await handleMessage(d, { chatId: 1, text: '/list' });
  assert.match(out[0], /Game `g1`\nServer unreachable, try later\./);
});

void test('/list omits timing when currentTurnStartTime is 0', async () => {
  const preview: GamePreview = {
    turns: 1,
    currentPlayer: 'civ1',
    currentTurnStartTime: 0,
    gameParameters: { minutesUntilSkipTurn: 0, minutesUntilForceResign: 0, minutesRecoveredPerTurn: 0 },
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 60 },
    ],
  };
  const { deps: d, out } = deps({ fetchPreview: () => Promise.resolve(preview) });
  const { addSubscription } = await import('./db');
  addSubscription(d.db, 1, 'g1', 'uA', '');
  await handleMessage(d, { chatId: 1, text: '/list' });
  assert.match(out[0], /Game `g1`\nTurn 1\nRome's turn\.\nYou: Rome$/m);
});

void test("/list shows whose turn and your civ when it's another civ's turn", async () => {
  const preview: GamePreview = {
    turns: 1,
    currentPlayer: 'civ1',
    currentTurnStartTime: 0,
    gameParameters: { minutesUntilSkipTurn: 0, minutesUntilForceResign: 0, minutesRecoveredPerTurn: 0 },
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 60 },
      { civID: 'civ2', civName: 'Greece', playerId: 'uB', playerType: 'Human', playerMinutesBeforeForceResign: 60 },
    ],
  };
  const { deps: d, out } = deps({ fetchPreview: () => Promise.resolve(preview) });
  const { addSubscription } = await import('./db');
  addSubscription(d.db, 1, 'g1', 'uB', '');
  await handleMessage(d, { chatId: 1, text: '/list' });
  // Rome's turn, but the subscriber plays Greece
  assert.match(out[0], /Game `g1`\nTurn 1\nRome's turn\.\nYou: Greece$/m);
});

void test('/list shows started but omits deadline when force-resign disabled', async () => {
  const preview: GamePreview = {
    turns: 1,
    currentPlayer: 'civ1',
    currentTurnStartTime: 1000,
    gameParameters: { minutesUntilSkipTurn: 0, minutesUntilForceResign: 0, minutesRecoveredPerTurn: 0 },
    civilizations: [
      { civID: 'civ1', civName: 'Greece', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 0 },
    ],
  };
  const { deps: d, out } = deps({ fetchPreview: () => Promise.resolve(preview) });
  const { addSubscription } = await import('./db');
  addSubscription(d.db, 1, 'g1', 'uA', '');
  await handleMessage(d, { chatId: 1, text: '/list' });
  assert.match(out[0], /Game `g1`\nTurn 1\nGreece's turn - started 30m ago\.\nYou: Greece/);
});

void test('register stores normalized username', async () => {
  const { deps: d } = deps();
  await handleMessage(d, { chatId: 1, username: '@Alice', text: '/subscribe g1 uA' });
  const { allSubscriptions } = await import('./db');
  assert.equal(allSubscriptions(d.db)[0].username, 'alice');
});

void test('register rejected when chat is blocked', async () => {
  const { deps: d, out } = deps();
  const { blockChat } = await import('./db');
  blockChat(d.db, 1);
  await handleMessage(d, { chatId: 1, username: 'amy', text: '/subscribe g1 uA' });
  assert.match(out[0], /blocked/i);
  const { allSubscriptions } = await import('./db');
  assert.equal(allSubscriptions(d.db).length, 0);
});

void test('/subs is admin only', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, username: 'amy', text: '/subs' });
  assert.match(out[0], /admin only/i);
});

void test('/subs lists all subscriptions for admin', async () => {
  const { deps: d, out } = deps({ adminSet: new Set(['boss']) });
  const { addSubscription } = await import('./db');
  addSubscription(d.db, 5, 'g1', 'uA', 'bob');
  await handleMessage(d, { chatId: 5, username: 'boss', text: '/subs' });
  assert.match(out[0], /5 \| @bob \| `g1` \| `uA`/);
});

void test('/block requires admin', async () => {
  const { deps: d, out } = deps();
  await handleMessage(d, { chatId: 1, username: 'amy', text: '/block @spammer' });
  assert.match(out[0], /admin only/i);
});

void test('/block by handle blocks and removes their subs', async () => {
  const { deps: d, out } = deps({ adminSet: new Set(['boss']) });
  const { addSubscription, isBlocked, allSubscriptions } = await import('./db');
  addSubscription(d.db, 9, 'g1', 'uA', 'spammer');
  await handleMessage(d, { chatId: 100, username: 'boss', text: '/block @Spammer' });
  assert.equal(isBlocked(d.db, 9, 'spammer'), true);
  assert.equal(allSubscriptions(d.db).length, 0);
  assert.match(out[0], /blocked .*spammer.*removed 1/i);
});

void test('/block by chat id blocks and removes their subs', async () => {
  const { deps: d, out } = deps({ adminSet: new Set(['boss']) });
  const { addSubscription, isBlocked } = await import('./db');
  addSubscription(d.db, 42, 'g1', 'uA', 'bob');
  await handleMessage(d, { chatId: 100, username: 'boss', text: '/block 42' });
  assert.equal(isBlocked(d.db, 42, ''), true);
  assert.match(out[0], /removed 1/i);
});

void test('/block with no arg shows usage', async () => {
  const { deps: d, out } = deps({ adminSet: new Set(['boss']) });
  await handleMessage(d, { chatId: 100, username: 'boss', text: '/block' });
  assert.match(out[0], /usage: \/block/i);
});

void test('/unblock by handle and chat id', async () => {
  const { deps: d, out } = deps({ adminSet: new Set(['boss']) });
  const { blockUsername, blockChat, isBlocked } = await import('./db');
  blockUsername(d.db, 'spammer');
  blockChat(d.db, 42);
  await handleMessage(d, { chatId: 100, username: 'boss', text: '/unblock @Spammer' });
  await handleMessage(d, { chatId: 100, username: 'boss', text: '/unblock 42' });
  assert.equal(isBlocked(d.db, 42, 'spammer'), false);
  assert.match(out[0], /unblocked/i);
});

void test('/unblock something not blocked reports not in blocklist', async () => {
  const { deps: d, out } = deps({ adminSet: new Set(['boss']) });
  await handleMessage(d, { chatId: 100, username: 'boss', text: '/unblock @ghost' });
  assert.match(out[0], /not in blocklist/i);
});

void test('/list is sent with markdown parse mode', async () => {
  const { deps: d, out, opts } = deps();
  await handleMessage(d, { chatId: 1, text: '/subscribe g1 uA' });
  out.length = 0;
  opts.length = 0;
  await handleMessage(d, { chatId: 1, text: '/list' });
  assert.match(out[0], /Game `g1`/);
  assert.deepEqual(opts[0], { markdown: true });
});
