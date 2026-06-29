import { test } from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';
import { decodePreview, isUsersTurn, DecodeError, fetchPreview, GameNotFound, currentTurn, formatDuration, formatTurnTimers } from './unciv';

function makeBlob(obj: unknown): string {
  return zlib.gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64');
}

const sample = {
  turns: 5,
  currentPlayer: 'civ1',
  civilizations: [
    { civID: 'civ1', civName: 'Rome', playerId: 'userA', playerType: 'Human' },
    { civID: 'civ2', civName: 'Greece', playerId: 'userB', playerType: 'Human' },
  ],
};

void test('decodePreview round-trips a base64+gzip JSON preview', () => {
  const p = decodePreview(makeBlob(sample));
  assert.equal(p.turns, 5);
  assert.equal(p.currentPlayer, 'civ1');
  assert.equal(p.civilizations.length, 2);
});

void test('decodePreview throws DecodeError on garbage', () => {
  assert.throws(() => decodePreview('not-base64-gzip'), DecodeError);
});

void test('decodePreview throws DecodeError on missing fields', () => {
  assert.throws(() => decodePreview(makeBlob({ foo: 1 })), DecodeError);
});

void test('isUsersTurn true when current civ playerId matches', () => {
  const p = decodePreview(makeBlob(sample));
  assert.equal(isUsersTurn(p, 'userA'), true);
});

void test('isUsersTurn false for other player', () => {
  const p = decodePreview(makeBlob(sample));
  assert.equal(isUsersTurn(p, 'userB'), false);
});

void test('isUsersTurn false when currentPlayer civ missing', () => {
  const p = decodePreview(makeBlob({ ...sample, currentPlayer: 'ghost' }));
  assert.equal(isUsersTurn(p, 'userA'), false);
});

function fakeFetch(status: number, body = ''): typeof fetch {
  return (() =>
    Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      text: () => Promise.resolve(body),
    })) as unknown as typeof fetch;
}

void test('fetchPreview returns decoded preview on 200', async () => {
  const blob = makeBlob(sample);
  const p = await fetchPreview('game1', fakeFetch(200, blob));
  assert.equal(p.currentPlayer, 'civ1');
});

void test('fetchPreview throws GameNotFound on 404', async () => {
  await assert.rejects(() => fetchPreview('game1', fakeFetch(404)), GameNotFound);
});

void test('fetchPreview throws on 500', async () => {
  await assert.rejects(() => fetchPreview('game1', fakeFetch(500)));
});

void test('decodePreview parses currentTurnStartTime and playerMinutesBeforeForceResign', () => {
  const body = makeBlob({
    turns: 5,
    currentPlayer: 'civ1',
    currentTurnStartTime: 1700000000000,
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 120 },
    ],
  });
  const p = decodePreview(body);
  assert.equal(p.currentTurnStartTime, 1700000000000);
  assert.equal(p.civilizations[0].playerMinutesBeforeForceResign, 120);
});

void test('decodePreview applies defaults when new fields absent', () => {
  const body = makeBlob({
    turns: 1,
    currentPlayer: 'civ1',
    civilizations: [{ civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human' }],
  });
  const p = decodePreview(body);
  assert.equal(p.currentTurnStartTime, 0);
  assert.equal(p.civilizations[0].playerMinutesBeforeForceResign, 0);
});

void test('currentTurn returns null deadlines when timers disabled', () => {
  const p = {
    turns: 5,
    currentPlayer: 'civ1',
    currentTurnStartTime: 1000,
    gameParameters: { minutesUntilSkipTurn: 0, minutesUntilForceResign: 0, minutesRecoveredPerTurn: 0 },
    civilizations: [
      { civID: 'civ1', civName: 'Greece', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 0 },
    ],
  };
  assert.deepEqual(currentTurn(p), {
    civName: 'Greece',
    playerId: 'uA',
    startedMs: 1000,
    skipDeadlineMs: null,
    totalDeadlineMs: null,
    recoveredPerTurnMin: 0,
  });
});

void test('currentTurn computes skip + total deadlines and recovery', () => {
  const p = {
    turns: 5,
    currentPlayer: 'civ1',
    currentTurnStartTime: 1000,
    gameParameters: { minutesUntilSkipTurn: 60, minutesUntilForceResign: 4320, minutesRecoveredPerTurn: 1440 },
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 120 },
    ],
  };
  assert.deepEqual(currentTurn(p), {
    civName: 'Rome',
    playerId: 'uA',
    startedMs: 1000,
    skipDeadlineMs: 1000 + 60 * 60000,
    totalDeadlineMs: 1000 + 120 * 60000,
    recoveredPerTurnMin: 1440,
  });
});

void test('currentTurn returns null when no civ matches currentPlayer', () => {
  const p = {
    turns: 5,
    currentPlayer: 'ghost',
    currentTurnStartTime: 0,
    gameParameters: { minutesUntilSkipTurn: 60, minutesUntilForceResign: 4320, minutesRecoveredPerTurn: 0 },
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 4320 },
    ],
  };
  assert.equal(currentTurn(p), null);
});

void test('decodePreview parses gameParameters', () => {
  const body = makeBlob({
    turns: 1,
    currentPlayer: 'civ1',
    gameParameters: { minutesUntilSkipTurn: 1440, minutesUntilForceResign: 4320, minutesRecoveredPerTurn: 720 },
    civilizations: [{ civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human' }],
  });
  const p = decodePreview(body);
  assert.deepEqual(p.gameParameters, {
    minutesUntilSkipTurn: 1440,
    minutesUntilForceResign: 4320,
    minutesRecoveredPerTurn: 720,
  });
});

void test('decodePreview defaults gameParameters to zeros when absent', () => {
  const body = makeBlob({
    turns: 1,
    currentPlayer: 'civ1',
    civilizations: [{ civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human' }],
  });
  const p = decodePreview(body);
  assert.deepEqual(p.gameParameters, {
    minutesUntilSkipTurn: 0,
    minutesUntilForceResign: 0,
    minutesRecoveredPerTurn: 0,
  });
});

void test('formatDuration drops trailing 0h for whole days', () => {
  assert.equal(formatDuration(1440 * 60000), '1d');
  assert.equal(formatDuration((1440 + 60) * 60000), '1d 1h');
});

void test('formatTurnTimers shows skip + total + recovered', () => {
  const lines = formatTurnTimers(
    { skipDeadlineMs: 1000 + 60 * 60000, totalDeadlineMs: 1000 + 120 * 60000, recoveredPerTurnMin: 1440 },
    1000,
  );
  assert.deepEqual(lines, ['⏭ Skip in: 1h', '⏳ Total left: 2h (+1d/turn)']);
});

void test('formatTurnTimers omits disabled timers and recovered suffix', () => {
  assert.deepEqual(
    formatTurnTimers({ skipDeadlineMs: null, totalDeadlineMs: 1000 + 60 * 60000, recoveredPerTurnMin: 0 }, 1000),
    ['⏳ Total left: 1h'],
  );
  assert.deepEqual(
    formatTurnTimers({ skipDeadlineMs: null, totalDeadlineMs: null, recoveredPerTurnMin: 0 }, 1000),
    [],
  );
});

void test('formatTurnTimers shows skippable/overdue past the deadline', () => {
  assert.deepEqual(
    formatTurnTimers({ skipDeadlineMs: 500, totalDeadlineMs: 500, recoveredPerTurnMin: 0 }, 1000),
    ['⏭ Skip in: can be skipped now', '⏳ Total left: overdue'],
  );
});
