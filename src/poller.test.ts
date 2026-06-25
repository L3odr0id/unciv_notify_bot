import { test } from 'node:test';
import assert from 'node:assert';
import { openDb, addSubscription, getGameState, distinctGameIds } from './db';
import { GamePreview, GameNotFound } from './unciv';
import { Alerter } from './alerts';
import { pollGame, pollOnce, startPoller, PollDeps } from './poller';
import { setLevel } from './log';
setLevel('silent');

const preview = (currentPlayer: string, turns = 1): GamePreview => ({
  turns,
  currentPlayer,
  civilizations: [
    { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human' },
    { civID: 'civ2', civName: 'Greece', playerId: 'uB', playerType: 'Human' },
  ],
});

function setup(fetchPreview: PollDeps['fetchPreview']) {
  const sent: { chatId: number; text: string }[] = [];
  const send = async (chatId: number, text: string) => {
    sent.push({ chatId, text });
  };
  const db = openDb(':memory:');
  const alerter = new Alerter({ send, adminChatIds: () => [], failThreshold: 2 });
  return { db, sent, deps: { db, fetchPreview, send, alerter } as PollDeps };
}

test('notifies only the subscriber whose turn it is', async () => {
  const { db, sent, deps } = setup(async () => preview('civ1'));
  addSubscription(db, 10, 'g1', 'uA');
  addSubscription(db, 20, 'g1', 'uB');
  await pollGame(deps, 'g1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 10);
  assert.match(sent[0].text, /It is uA turn in game g1/);
  assert.deepEqual(getGameState(db, 'g1'), { last_turns: 1, last_current_player: 'civ1' });
});

test('no notification when state unchanged', async () => {
  const { db, sent, deps } = setup(async () => preview('civ1'));
  addSubscription(db, 10, 'g1', 'uA');
  await pollGame(deps, 'g1'); // first time notifies + stores
  assert.equal(sent.length, 1);
  await pollGame(deps, 'g1'); // unchanged → silent
  assert.equal(sent.length, 1);
});

test('404 notifies all subscribers and deletes the game', async () => {
  const { db, sent, deps } = setup(async () => {
    throw new GameNotFound('g1');
  });
  addSubscription(db, 10, 'g1', 'uA');
  addSubscription(db, 20, 'g1', 'uB');
  await pollGame(deps, 'g1');
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /finished or was removed/);
  assert.equal(distinctGameIds(db).length, 0);
});

test('repeated failures reach the alerter threshold', async () => {
  const alerts: string[] = [];
  const db = openDb(':memory:');
  const alerter = new Alerter({
    send: async (_c, t) => {
      alerts.push(t);
    },
    adminChatIds: () => [1],
    failThreshold: 2,
  });
  addSubscription(db, 10, 'g1', 'uA');
  const deps = {
    db,
    fetchPreview: async () => {
      throw new Error('network down');
    },
    send: async () => {},
    alerter,
  } as PollDeps;
  await pollGame(deps, 'g1');
  assert.equal(alerts.length, 0);
  await pollGame(deps, 'g1');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /g1 failing/);
});

test('pollOnce iterates all distinct games', async () => {
  const seen: string[] = [];
  const { db, deps } = setup(async (gid) => {
    seen.push(gid);
    return preview('civ1');
  });
  addSubscription(db, 1, 'g1', 'uA');
  addSubscription(db, 2, 'g2', 'uA');
  await pollOnce(deps);
  assert.deepEqual(seen.sort(), ['g1', 'g2']);
});

test('startPoller: stop() before first tick prevents pollOnce', async () => {
  const { db, deps } = setup(async () => preview('civ1'));
  addSubscription(db, 10, 'g1', 'uA');

  const { stop } = startPoller(deps, () => 10000);
  stop();

  // Wait a short real delay to ensure any pending callback is dropped
  await new Promise((r) => setTimeout(r, 20));

  // pollOnce should not have run, so fetchPreview never called
  const gameIds = distinctGameIds(db);
  assert.equal(gameIds.length, 1); // subscription still exists
  // If pollOnce ran, getGameState would have been populated; it should be null
  assert.equal(getGameState(db, 'g1'), null);
});

test('startPoller: tick fires pollOnce and getIntervalMs is read per tick', async () => {
  let intervalCallCount = 0;
  let fetchPreviewCallCount = 0;

  const { db, deps } = setup(async () => {
    fetchPreviewCallCount++;
    return preview('civ1');
  });
  addSubscription(db, 10, 'g1', 'uA');

  const getInterval = () => {
    intervalCallCount++;
    return 1; // 1ms interval for fast ticking
  };

  const { stop } = startPoller(deps, getInterval);

  // Wait long enough for at least 2 ticks (initial schedule + reschedule)
  await new Promise((r) => setTimeout(r, 30));

  stop();

  // Verify pollOnce ran at least once
  assert.ok(fetchPreviewCallCount >= 1, `fetchPreview should be called >= 1 time, got ${fetchPreviewCallCount}`);

  // Verify getIntervalMs was called >= 2 times (initial + at least one reschedule)
  assert.ok(intervalCallCount >= 2, `getIntervalMs should be called >= 2 times, got ${intervalCallCount}`);
});

test('startPoller: pollOnce error routes to alerter.fatal', async () => {
  const fatals: string[] = [];
  const db = openDb(':memory:');
  const alerter = new Alerter({
    send: async () => {},
    adminChatIds: () => [],
    failThreshold: 2,
  });
  // Override fatal to capture the message
  alerter.fatal = async (msg: string) => {
    fatals.push(msg);
  };

  addSubscription(db, 10, 'g1', 'uA');

  // Create a deps with a db.distinctGameIds that throws
  const deps = {
    db: {
      ...db,
      distinctGameIds: () => {
        throw new Error('db error');
      },
    } as any,
    fetchPreview: async () => preview('civ1'),
    send: async () => {},
    alerter,
  } as PollDeps;

  const { stop } = startPoller(deps, () => 1);

  // Wait for at least one tick to fail
  await new Promise((r) => setTimeout(r, 30));

  stop();

  // Verify alerter.fatal was called with the error
  assert.ok(fatals.length >= 1, `alerter.fatal should be called >= 1 time, got ${fatals.length}`);
  assert.match(fatals[0], /poll loop error/);
});
