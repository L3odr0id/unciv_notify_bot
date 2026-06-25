import { test } from 'node:test';
import assert from 'node:assert';
import { log, setLevel } from './log';

function capture(fn: () => void): { out: string; err: string } {
  let out = '';
  let err = '';
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (s: string) => ((out += s), true);
  (process.stderr.write as unknown) = (s: string) => ((err += s), true);
  try {
    fn();
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return { out, err };
}

test('info level: debug suppressed, info to stdout with timestamped format', () => {
  setLevel('info');
  const { out } = capture(() => {
    log.debug('dbg');
    log.info('hello');
  });
  assert.ok(!out.includes('dbg'));
  assert.match(out, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO hello\n$/);
});

test('warn and error go to stderr, not stdout', () => {
  setLevel('info');
  const { out, err } = capture(() => {
    log.warn('w');
    log.error('e');
  });
  assert.equal(out, '');
  assert.match(err, /WARN w/);
  assert.match(err, /ERROR e/);
});

test('silent suppresses everything', () => {
  setLevel('silent');
  const { out, err } = capture(() => {
    log.info('x');
    log.error('y');
  });
  assert.equal(out + err, '');
  setLevel('info');
});

test('debug level lets debug through and appends extra args', () => {
  setLevel('debug');
  const { out } = capture(() => log.debug('d', { a: 1 }));
  assert.match(out, /DEBUG d \{"a":1\}/);
  setLevel('info');
});
