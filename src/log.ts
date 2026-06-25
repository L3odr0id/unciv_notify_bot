export type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function parseLevel(v: string | undefined): Level {
  return v && v in ORDER ? (v as Level) : 'info';
}

let current: Level = parseLevel(process.env.LOG_LEVEL);

export function setLevel(level: Level): void {
  current = level;
}

function emit(
  level: Exclude<Level, 'silent'>,
  stream: NodeJS.WriteStream,
  message: string,
  args: unknown[],
): void {
  if (ORDER[level] < ORDER[current]) return;
  const extra = args.length
    ? ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    : '';
  stream.write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${extra}\n`);
}

export const log = {
  debug: (m: string, ...a: unknown[]) => emit('debug', process.stdout, m, a),
  info: (m: string, ...a: unknown[]) => emit('info', process.stdout, m, a),
  warn: (m: string, ...a: unknown[]) => emit('warn', process.stderr, m, a),
  error: (m: string, ...a: unknown[]) => emit('error', process.stderr, m, a),
};
