import { test } from 'node:test';
import assert from 'node:assert';
import { openDb, addSubscription, getGameState, distinctGameIds, DB } from './db';
import { GamePreview, GameNotFound } from './unciv';
import { Alerter } from './alerts';
import { pollGame, pollOnce, startPoller, PollDeps } from './poller';
import { setLevel } from './log';
setLevel('silent');

const preview = (currentPlayer: string, turns = 1): GamePreview => ({
  turns,
  currentPlayer,
  currentTurnStartTime: 0,
  gameParameters: { minutesUntilSkipTurn: 0, minutesUntilForceResign: 0, minutesRecoveredPerTurn: 0 },
  civilizations: [
    { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 4320 },
    { civID: 'civ2', civName: 'Greece', playerId: 'uB', playerType: 'Human', playerMinutesBeforeForceResign: 4320 },
  ],
});

function setup(fetchPreview: PollDeps['fetchPreview']) {
  const sent: { chatId: number; text: string }[] = [];
  const send = (chatId: number, text: string) => {
    sent.push({ chatId, text });
    return Promise.resolve();
  };
  const db = openDb(':memory:');
  const alerter = new Alerter({ send, adminChatIds: () => [], failThreshold: 2 });
  return { db, sent, deps: { db, fetchPreview, send, alerter } as PollDeps };
}

void test('notifies only the subscriber whose turn it is', async () => {
  const { db, sent, deps } = setup(() => Promise.resolve(preview('civ1')));
  addSubscription(db, 10, 'g1', 'uA');
  addSubscription(db, 20, 'g1', 'uB');
  await pollGame(deps, 'g1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 10);
  assert.match(sent[0].text, /It is Rome's \(uA\) turn in game g1/);
  assert.deepEqual(getGameState(db, 'g1'), { last_turns: 1, last_current_player: 'civ1' });
});

void test('notification includes skip and total timers when enabled', async () => {
  const withTimers: GamePreview = {
    turns: 1,
    currentPlayer: 'civ1',
    currentTurnStartTime: 1000,
    gameParameters: { minutesUntilSkipTurn: 60, minutesUntilForceResign: 4320, minutesRecoveredPerTurn: 0 },
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 90 },
    ],
  };
  const { db, sent, deps } = setup(() => Promise.resolve(withTimers));
  deps.now = () => 1000 + 30 * 60000; // 30 min into the turn
  addSubscription(db, 10, 'g1', 'uA');
  await pollGame(deps, 'g1');
  assert.equal(
    sent[0].text,
    "🔔 It is Rome's (uA) turn in game g1.\n   ⏭ Skip in: 30m\n   ⏳ Total left: 1h",
  );
});

void test('notification omits deadline when force-resign disabled', async () => {
  const noDeadline: GamePreview = {
    turns: 1,
    currentPlayer: 'civ1',
    currentTurnStartTime: 1000,
    gameParameters: { minutesUntilSkipTurn: 0, minutesUntilForceResign: 0, minutesRecoveredPerTurn: 0 },
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 0 },
    ],
  };
  const { db, sent, deps } = setup(() => Promise.resolve(noDeadline));
  addSubscription(db, 10, 'g1', 'uA');
  await pollGame(deps, 'g1');
  assert.equal(sent[0].text, "🔔 It is Rome's (uA) turn in game g1.");
});

void test('no notification when state unchanged', async () => {
  const { db, sent, deps } = setup(() => Promise.resolve(preview('civ1')));
  addSubscription(db, 10, 'g1', 'uA');
  await pollGame(deps, 'g1'); // first time notifies + stores
  assert.equal(sent.length, 1);
  await pollGame(deps, 'g1'); // unchanged → silent
  assert.equal(sent.length, 1);
});

void test('404 notifies all subscribers and deletes the game', async () => {
  const { db, sent, deps } = setup(() => Promise.reject(new GameNotFound('g1')));
  addSubscription(db, 10, 'g1', 'uA');
  addSubscription(db, 20, 'g1', 'uB');
  await pollGame(deps, 'g1');
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /finished or was removed/);
  assert.equal(distinctGameIds(db).length, 0);
});

void test('repeated failures reach the alerter threshold', async () => {
  const alerts: string[] = [];
  const db = openDb(':memory:');
  const alerter = new Alerter({
    send: (_c, t) => {
      alerts.push(t);
      return Promise.resolve();
    },
    adminChatIds: () => [1],
    failThreshold: 2,
  });
  addSubscription(db, 10, 'g1', 'uA');
  const deps = {
    db,
    fetchPreview: () => Promise.reject(new Error('network down')),
    send: () => Promise.resolve(),
    alerter,
  } as PollDeps;
  await pollGame(deps, 'g1');
  assert.equal(alerts.length, 0);
  await pollGame(deps, 'g1');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /g1 failing/);
});

void test('pollOnce iterates all distinct games', async () => {
  const seen: string[] = [];
  const { db, deps } = setup((gid) => {
    seen.push(gid);
    return Promise.resolve(preview('civ1'));
  });
  addSubscription(db, 1, 'g1', 'uA');
  addSubscription(db, 2, 'g2', 'uA');
  await pollOnce(deps);
  assert.deepEqual(seen.sort(), ['g1', 'g2']);
});

void test('startPoller: stop() before first tick prevents pollOnce', async () => {
  const { db, deps } = setup(() => Promise.resolve(preview('civ1')));
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

void test('startPoller: tick fires pollOnce and getIntervalMs is read per tick', async () => {
  let intervalCallCount = 0;
  let fetchPreviewCallCount = 0;

  const { db, deps } = setup(() => {
    fetchPreviewCallCount++;
    return Promise.resolve(preview('civ1'));
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

void test('startPoller: pollOnce error routes to alerter.fatal', async () => {
  const fatals: string[] = [];
  const db = openDb(':memory:');
  const alerter = new Alerter({
    send: () => Promise.resolve(),
    adminChatIds: () => [],
    failThreshold: 2,
  });
  // Override fatal to capture the message
  alerter.fatal = (msg: string) => {
    fatals.push(msg);
    return Promise.resolve();
  };

  addSubscription(db, 10, 'g1', 'uA');

  // Create a deps with a db.distinctGameIds that throws
  const deps = {
    db: {
      ...db,
      distinctGameIds: () => {
        throw new Error('db error');
      },
    } as unknown as DB,
    fetchPreview: () => Promise.resolve(preview('civ1')),
    send: () => Promise.resolve(),
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
