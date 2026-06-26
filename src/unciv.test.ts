import { test } from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';
import { decodePreview, isUsersTurn, DecodeError, GamePreview, fetchPreview, GameNotFound, currentTurn } from './unciv';

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

test('decodePreview round-trips a base64+gzip JSON preview', () => {
  const p = decodePreview(makeBlob(sample));
  assert.equal(p.turns, 5);
  assert.equal(p.currentPlayer, 'civ1');
  assert.equal(p.civilizations.length, 2);
});

test('decodePreview throws DecodeError on garbage', () => {
  assert.throws(() => decodePreview('not-base64-gzip'), DecodeError);
});

test('decodePreview throws DecodeError on missing fields', () => {
  assert.throws(() => decodePreview(makeBlob({ foo: 1 })), DecodeError);
});

test('isUsersTurn true when current civ playerId matches', () => {
  const p = decodePreview(makeBlob(sample)) as GamePreview;
  assert.equal(isUsersTurn(p, 'userA'), true);
});

test('isUsersTurn false for other player', () => {
  const p = decodePreview(makeBlob(sample)) as GamePreview;
  assert.equal(isUsersTurn(p, 'userB'), false);
});

test('isUsersTurn false when currentPlayer civ missing', () => {
  const p = decodePreview(makeBlob({ ...sample, currentPlayer: 'ghost' }));
  assert.equal(isUsersTurn(p, 'userA'), false);
});

function fakeFetch(status: number, body = ''): typeof fetch {
  return (async () =>
    ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
    }) as Response) as unknown as typeof fetch;
}

test('fetchPreview returns decoded preview on 200', async () => {
  const blob = makeBlob(sample);
  const p = await fetchPreview('game1', fakeFetch(200, blob));
  assert.equal(p.currentPlayer, 'civ1');
});

test('fetchPreview throws GameNotFound on 404', async () => {
  await assert.rejects(() => fetchPreview('game1', fakeFetch(404)), GameNotFound);
});

test('fetchPreview throws on 500', async () => {
  await assert.rejects(() => fetchPreview('game1', fakeFetch(500)));
});

test('decodePreview parses currentTurnStartTime and playerMinutesBeforeForceResign', () => {
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

test('decodePreview applies defaults when new fields absent', () => {
  const body = makeBlob({
    turns: 1,
    currentPlayer: 'civ1',
    civilizations: [{ civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human' }],
  });
  const p = decodePreview(body);
  assert.equal(p.currentTurnStartTime, 0);
  assert.equal(p.civilizations[0].playerMinutesBeforeForceResign, 0);
});

test('currentTurn returns null deadline when force-resign disabled (pmbfr 0)', () => {
  const p = {
    turns: 5,
    currentPlayer: 'civ1',
    currentTurnStartTime: 1000,
    civilizations: [
      { civID: 'civ1', civName: 'Greece', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 0 },
    ],
  };
  assert.deepEqual(currentTurn(p), {
    civName: 'Greece',
    playerId: 'uA',
    startedMs: 1000,
    deadlineMs: null,
  });
});

test('currentTurn resolves civ name, player id, started and deadline', () => {
  const p = {
    turns: 5,
    currentPlayer: 'civ1',
    currentTurnStartTime: 1000,
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 2 },
    ],
  };
  const ct = currentTurn(p);
  assert.deepEqual(ct, { civName: 'Rome', playerId: 'uA', startedMs: 1000, deadlineMs: 1000 + 2 * 60000 });
});

test('currentTurn returns null when no civ matches currentPlayer', () => {
  const p = {
    turns: 5,
    currentPlayer: 'ghost',
    currentTurnStartTime: 0,
    civilizations: [
      { civID: 'civ1', civName: 'Rome', playerId: 'uA', playerType: 'Human', playerMinutesBeforeForceResign: 4320 },
    ],
  };
  assert.equal(currentTurn(p), null);
});
