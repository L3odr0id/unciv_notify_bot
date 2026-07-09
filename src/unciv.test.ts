import { test } from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';
import { decodePreview, isUsersTurn, DecodeError, fetchPreview, GameNotFound, currentTurn, formatDuration, formatTurnTimers, playerResignBankMin, blameBanks, formatBlame } from './unciv';

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

void test('decodePreview accepts previews without turn counter', () => {
  const p = decodePreview(
    makeBlob({
      currentPlayer: 'Austria',
      currentTurnStartTime: 1700000000000,
      civilizations: [{ civID: 'Austria', civName: 'Austria', playerId: 'uA', playerType: 'Human' }],
    }),
  );
  assert.equal(p.turns, null);
  assert.equal(p.currentPlayer, 'Austria');
  assert.equal(p.civilizations[0].playerId, 'uA');
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
  // Unciv (libGDX Json + usePrototypes) omits fields at their class default, so
  // an absent playerMinutesBeforeForceResign means the default 3-day bank, not 0.
  assert.equal(p.civilizations[0].playerMinutesBeforeForceResign, 4320);
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

void test('decodePreview defaults absent gameParameters to Unciv defaults', () => {
  // libGDX Json omits fields equal to their class default; absent timer params
  // therefore mean "default" (non-zero), not "disabled".
  const body = makeBlob({
    turns: 1,
    currentPlayer: 'civ1',
    civilizations: [{ civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human' }],
  });
  const p = decodePreview(body);
  assert.deepEqual(p.gameParameters, {
    minutesUntilSkipTurn: 1440,
    minutesUntilForceResign: 4320,
    minutesRecoveredPerTurn: 1440,
  });
});

void test('decodePreview keeps an explicit gameParameters value of 0', () => {
  // An explicit 0 (not omittable, since 0 != default) means the feature was
  // forced off via an edited save — preserve it so currentTurn omits the line.
  const body = makeBlob({
    turns: 1,
    currentPlayer: 'civ1',
    gameParameters: { minutesUntilForceResign: 0 },
    civilizations: [{ civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human' }],
  });
  const p = decodePreview(body);
  assert.equal(p.gameParameters.minutesUntilForceResign, 0);
  assert.equal(p.gameParameters.minutesUntilSkipTurn, 1440);
});

void test('formatDuration drops trailing 0h for whole days', () => {
  assert.equal(formatDuration(1440 * 60000), '1d');
  assert.equal(formatDuration((1440 + 60) * 60000), '1d 1h');
  assert.equal(formatDuration((1440 + 60 + 5) * 60000), '1d 1h 5m');
});

void test('formatTurnTimers shows skip + kick', () => {
  const lines = formatTurnTimers(
    { skipDeadlineMs: 1000 + 60 * 60000, totalDeadlineMs: 1000 + 120 * 60000, recoveredPerTurnMin: 1440 },
    1000,
  );
  assert.deepEqual(lines, [
    '⏭ Others can skip this turn in: 1h',
    '⏳ Others can force-resign this player in: 2h',
  ]);
});

void test('formatTurnTimers omits disabled timers', () => {
  assert.deepEqual(
    formatTurnTimers({ skipDeadlineMs: null, totalDeadlineMs: 1000 + 60 * 60000, recoveredPerTurnMin: 0 }, 1000),
    ['⏳ Others can force-resign this player in: 1h'],
  );
  assert.deepEqual(
    formatTurnTimers({ skipDeadlineMs: null, totalDeadlineMs: null, recoveredPerTurnMin: 0 }, 1000),
    [],
  );
});

void test('formatTurnTimers shows skippable/overdue past the deadline', () => {
  assert.deepEqual(
    formatTurnTimers({ skipDeadlineMs: 500, totalDeadlineMs: 500, recoveredPerTurnMin: 0 }, 1000),
    ['⏭ Others can skip this turn now', '⏳ Others can force-resign this player now'],
  );
});

void test('playerResignBankMin returns bank when force-resign enabled', () => {
  const p = {
    turns: 1,
    currentPlayer: 'civ1',
    currentTurnStartTime: 1000,
    gameParameters: { minutesUntilSkipTurn: 60, minutesUntilForceResign: 4320, minutesRecoveredPerTurn: 0 },
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 90 },
      { civID: 'civ2', civName: 'Greece', playerId: 'uB', playerType: 'Human', playerMinutesBeforeForceResign: 150 },
    ],
  };
  assert.equal(playerResignBankMin(p, 'uB'), 150);
  assert.equal(playerResignBankMin(p, 'missing'), null);
});

void test('playerResignBankMin is null when force-resign disabled', () => {
  const p = {
    turns: 1,
    currentPlayer: 'civ1',
    currentTurnStartTime: 1000,
    gameParameters: { minutesUntilSkipTurn: 0, minutesUntilForceResign: 0, minutesRecoveredPerTurn: 0 },
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 90 },
    ],
  };
  assert.equal(playerResignBankMin(p, 'uA'), null);
});

void test('blameBanks sorts by bank ascending and marks current', () => {
  const p = {
    turns: 1,
    currentPlayer: 'civ2',
    currentTurnStartTime: 1000,
    gameParameters: { minutesUntilSkipTurn: 60, minutesUntilForceResign: 4320, minutesRecoveredPerTurn: 0 },
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 200 },
      { civID: 'civ2', civName: 'Greece', playerId: 'uB', playerType: 'Human', playerMinutesBeforeForceResign: 90 },
      { civID: 'civ3', civName: 'Barbarians', playerId: '', playerType: 'AI', playerMinutesBeforeForceResign: 10 },
    ],
  };
  assert.deepEqual(blameBanks(p), [
    { civName: 'Greece', playerId: 'uB', bankMin: 90, isCurrent: true },
    { civName: 'Rome', playerId: 'uA', bankMin: 200, isCurrent: false },
  ]);
});

void test('formatBlame lists banks lowest first', () => {
  const p = {
    turns: 5,
    currentPlayer: 'civ1',
    currentTurnStartTime: 1000,
    gameParameters: { minutesUntilSkipTurn: 90, minutesUntilForceResign: 4320, minutesRecoveredPerTurn: 0 },
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 60 },
      { civID: 'civ2', civName: 'Greece', playerId: 'uB', playerType: 'Human', playerMinutesBeforeForceResign: 150 },
    ],
  };
  assert.equal(
    formatBlame(p, 'g1', 1000 + 30 * 60000),
    [
      'Game `g1`',
      'Turn 5',
      "Rome's turn - started 30m ago.",
      '   ⏭ Others can skip this turn in: 1h',
      '   ⏳ Others can force-resign this player in: 30m',
      'Time before force-resign (lowest first):',
      '   Rome: 1h ← current turn',
      '   Greece: 2h 30m',
    ].join('\n'),
  );
});

void test('formatBlame reports when force-resign is disabled', () => {
  const p = {
    turns: 1,
    currentPlayer: 'civ1',
    currentTurnStartTime: 1000,
    gameParameters: { minutesUntilSkipTurn: 0, minutesUntilForceResign: 0, minutesRecoveredPerTurn: 0 },
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 60 },
    ],
  };
  assert.match(formatBlame(p, 'g1', 1000), /Force-resign is disabled/);
});
