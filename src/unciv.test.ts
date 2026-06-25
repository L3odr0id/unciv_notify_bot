import { test } from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';
import { decodePreview, isUsersTurn, DecodeError, GamePreview, fetchPreview, GameNotFound } from './unciv';

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
