import { test } from 'node:test';
import assert from 'node:assert';
import { Alerter } from './alerts';
import { setLevel } from './log';
setLevel('silent');

function collector() {
  const sent: { chatId: number; text: string }[] = [];
  return {
    sent,
    send: (chatId: number, text: string) => {
      sent.push({ chatId, text });
      return Promise.resolve();
    },
  };
}

void test('recordFailure alerts once at threshold, not before', async () => {
  const c = collector();
  const a = new Alerter({ send: c.send, adminChatIds: () => [1, 2], failThreshold: 3 });
  await a.recordFailure('g1', 'boom');
  await a.recordFailure('g1', 'boom');
  assert.equal(c.sent.length, 0);
  await a.recordFailure('g1', 'boom'); // 3rd → alert to each admin
  assert.equal(c.sent.length, 2);
  await a.recordFailure('g1', 'boom'); // suppressed after alerting
  assert.equal(c.sent.length, 2);
});

void test('recordSuccess resets so a later failure can alert again', async () => {
  const c = collector();
  const a = new Alerter({ send: c.send, adminChatIds: () => [1], failThreshold: 1 });
  await a.recordFailure('g1', 'boom');
  assert.equal(c.sent.length, 1);
  a.recordSuccess('g1');
  await a.recordFailure('g1', 'boom');
  assert.equal(c.sent.length, 2);
});

void test('telegramFailure is throttled by time window', async () => {
  const c = collector();
  let t = 0;
  const a = new Alerter({ send: c.send, adminChatIds: () => [1], now: () => t, tgThrottleMs: 1000 });
  await a.telegramFailure(new Error('x'));
  await a.telegramFailure(new Error('x')); // within window → suppressed
  assert.equal(c.sent.length, 1);
  t = 1001;
  await a.telegramFailure(new Error('x'));
  assert.equal(c.sent.length, 2);
});

void test('telegramFailure ignores transient network errors', async () => {
  const c = collector();
  const a = new Alerter({ send: c.send, adminChatIds: () => [1], tgThrottleMs: 0 });
  await a.telegramFailure(new Error('EFATAL: Error: read ECONNRESET'));
  await a.telegramFailure(new Error('socket hang up'));
  await a.telegramFailure(new Error('ETIMEDOUT'));
  assert.equal(c.sent.length, 0);
  await a.telegramFailure(new Error('403 Forbidden: bot blocked')); // real → alerts
  assert.equal(c.sent.length, 1);
});

void test('fatal alerts all admins immediately', async () => {
  const c = collector();
  const a = new Alerter({ send: c.send, adminChatIds: () => [1, 2] });
  await a.fatal('died');
  assert.equal(c.sent.length, 2);
});
