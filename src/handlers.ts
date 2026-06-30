import {
  DB,
  addSubscription,
  removeSubscription,
  listSubscriptions,
  upsertAdmin,
  getSetting,
  setSetting,
  stats,
  isBlocked,
  allSubscriptions,
  blockUsername,
  blockChat,
  unblockUsername,
  unblockChat,
  removeByUsername,
  removeByChat,
} from './db';
import {
  GamePreview,
  GameNotFound,
  currentTurn,
  civForPlayer,
  formatDuration,
  formatTurnTimers,
} from './unciv';
import { MIN_INTERVAL_SECONDS } from './constants';
import { SendOpts, code, esc } from './tg';
import { log } from './log';

export function normalizeUsername(u: string): string {
  return u.trim().toLowerCase().replace(/^@/, '');
}

export function parseAdminSet(envValue: string | undefined): Set<string> {
  const set = new Set<string>();
  for (const part of (envValue ?? '').split(',')) {
    const n = normalizeUsername(part);
    if (n) set.add(n);
  }
  return set;
}

// A bare integer (optionally negative — Telegram group chat ids are negative) is a chat id; anything else is a handle.
function parseBlockTarget(arg: string): { kind: 'chat'; chatId: number } | { kind: 'user'; username: string } {
  if (/^-?\d+$/.test(arg)) return { kind: 'chat', chatId: Number(arg) };
  return { kind: 'user', username: normalizeUsername(arg) };
}

export const USAGE = [
  'Unciv turn-notifier bot.',
  '',
  'Commands:',
  '  /subscribe <game_id> <user_id> — get notified on your turn',
  '  /list — your subscriptions with live turn status',
  '  /unsubscribe <game_id> [user_id] — stop notifications',
  '  /getinterval — current polling interval in seconds',
].join('\n');

export interface IncomingMsg {
  chatId: number;
  username?: string;
  text: string;
}

export interface HandlerDeps {
  db: DB;
  adminSet: Set<string>;
  fallbackIntervalSeconds: number;
  now: () => number;
  fetchPreview: (gameId: string) => Promise<GamePreview>;
  reply: (text: string, opts?: SendOpts) => Promise<void>;
}

function isAdmin(deps: HandlerDeps, msg: IncomingMsg): boolean {
  return !!msg.username && deps.adminSet.has(normalizeUsername(msg.username));
}

export async function handleMessage(deps: HandlerDeps, msg: IncomingMsg): Promise<void> {
  // Learn admin chat_id on any contact.
  if (isAdmin(deps, msg)) {
    upsertAdmin(deps.db, normalizeUsername(msg.username!), msg.chatId);
  }

  const text = msg.text.trim();

  if (text === '/start' || text === '/help') {
    return deps.reply(USAGE);
  }

  if (text === '/list') {
    const subs = listSubscriptions(deps.db, msg.chatId);
    if (subs.length === 0) return deps.reply('No subscriptions.');
    // De-dupe network fetches: one preview per distinct game, shared across subs.
    const games = [...new Set(subs.map((s) => s.game_id))];
    const previews = new Map<string, GamePreview | GameNotFound | Error>();
    await Promise.all(
      games.map(async (gameId) => {
        try {
          previews.set(gameId, await deps.fetchPreview(gameId));
        } catch (e) {
          previews.set(gameId, e instanceof Error ? e : new Error(String(e)));
        }
      }),
    );
    const lines = subs.map((s) => {
      const p = previews.get(s.game_id);
      if (p instanceof GameNotFound) return `Game ${code(s.game_id)}\nFinished or deleted.`;
      if (p instanceof Error || !p) return `Game ${code(s.game_id)}\nServer unreachable, try later.`;
      const ct = currentTurn(p);
      let turn = ct ? `${esc(ct.civName)}'s turn` : 'Turn unknown';
      let timerBlock = '';
      if (ct && ct.startedMs > 0) {
        const now = deps.now();
        turn += ` - started ${formatDuration(now - ct.startedMs)} ago`;
        const lines = formatTurnTimers(ct, now);
        if (lines.length) timerBlock = '\n' + lines.map((l) => `   ${l}`).join('\n');
      }
      turn += '.';
      const civName = civForPlayer(p, s.user_id);
      const you = civName ? esc(civName) : `player ${code(s.user_id)} (not in game)`;
      return `Game ${code(s.game_id)}\nTurn ${p.turns}\n${turn}${timerBlock}\nYou: ${you}`;
    });
    return deps.reply(`Your subscriptions:\n\n${lines.join('\n\n')}`, { markdown: true });
  }

  if (text.startsWith('/unsubscribe')) {
    const [, gameId, userId] = text.split(/\s+/);
    if (!gameId) return deps.reply('Usage: /unsubscribe <game_id> [user_id]');
    const removed = removeSubscription(deps.db, msg.chatId, gameId, userId);
    if (removed > 0) log.info(`chat ${msg.chatId} unsubscribed ${gameId} (${removed})`);
    return deps.reply(removed > 0 ? `Removed ${removed} subscription(s).` : 'Nothing to remove.');
  }

  if (text === '/getinterval') {
    const stored = getSetting(deps.db, 'poll_interval_seconds');
    const chosen = Number.isFinite(Number(stored)) ? Number(stored) : deps.fallbackIntervalSeconds;
    const seconds = Math.max(chosen, MIN_INTERVAL_SECONDS);
    return deps.reply(`Polling interval: ${seconds}s.`);
  }

  if (text.startsWith('/setinterval')) {
    if (!isAdmin(deps, msg)) return deps.reply('Admin only.');
    const seconds = Number(text.split(/\s+/)[1]);
    if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS) {
      return deps.reply(`Interval must be an integer of at least ${MIN_INTERVAL_SECONDS} seconds.`);
    }
    setSetting(deps.db, 'poll_interval_seconds', String(seconds));
    log.info(`admin ${msg.chatId} set poll interval to ${seconds}s`);
    return deps.reply(`Poll interval set to ${seconds}s (applies next cycle).`);
  }

  if (text === '/stats') {
    if (!isAdmin(deps, msg)) return deps.reply('Admin only.');
    const s = stats(deps.db);
    return deps.reply(`games: ${s.games}, subscriptions: ${s.subs}, admins: ${s.admins}`);
  }

  if (text === '/subs') {
    if (!isAdmin(deps, msg)) return deps.reply('Admin only.');
    const subs = allSubscriptions(deps.db);
    if (subs.length === 0) return deps.reply('No subscriptions.');
    const lines = subs
      .slice(0, 50)
      .map((s) => `${s.chat_id} | @${esc(s.username || '?')} | ${code(s.game_id)} | ${code(s.user_id)}`);
    if (subs.length > 50) lines.push(`…and ${subs.length - 50} more.`);
    return deps.reply(lines.join('\n'), { markdown: true });
  }

  if (text.startsWith('/block')) {
    if (!isAdmin(deps, msg)) return deps.reply('Admin only.');
    const arg = text.split(/\s+/)[1];
    if (!arg) return deps.reply('Usage: /block <@handle|chat_id>');
    const target = parseBlockTarget(arg);
    let removed: number;
    if (target.kind === 'chat') {
      blockChat(deps.db, target.chatId);
      removed = removeByChat(deps.db, target.chatId);
    } else {
      blockUsername(deps.db, target.username);
      removed = removeByUsername(deps.db, target.username);
    }
    log.info(`admin ${msg.chatId} blocked ${arg} (removed ${removed} subs)`);
    return deps.reply(`Blocked ${arg}; removed ${removed} subscription(s).`);
  }

  if (text.startsWith('/unblock')) {
    if (!isAdmin(deps, msg)) return deps.reply('Admin only.');
    const arg = text.split(/\s+/)[1];
    if (!arg) return deps.reply('Usage: /unblock <@handle|chat_id>');
    const target = parseBlockTarget(arg);
    const changes =
      target.kind === 'chat' ? unblockChat(deps.db, target.chatId) : unblockUsername(deps.db, target.username);
    if (changes > 0) log.info(`admin ${msg.chatId} unblocked ${arg}`);
    return deps.reply(changes > 0 ? `Unblocked ${arg}.` : 'Not in blocklist.');
  }

  if (text.startsWith('/subscribe')) {
    const [, gameId, userId] = text.split(/\s+/);
    if (!gameId || !userId) return deps.reply('Usage: /subscribe <game_id> <user_id>');
    return subscribe(deps, msg, gameId, userId);
  }

  return deps.reply(USAGE);
}

async function subscribe(deps: HandlerDeps, msg: IncomingMsg, gameId: string, userId: string): Promise<void> {
  const uname = normalizeUsername(msg.username ?? '');
  if (isBlocked(deps.db, msg.chatId, uname)) return deps.reply('You are blocked.');
  let preview: GamePreview;
  try {
    preview = await deps.fetchPreview(gameId);
  } catch (e) {
    if (e instanceof GameNotFound) return deps.reply(`Game ${code(gameId)} not found.`, { markdown: true });
    return deps.reply('Could not reach the Unciv server, try again later.');
  }
  if (!preview.civilizations.some((c) => c.playerId === userId)) {
    log.debug(`register rejected: ${userId} not in ${gameId}`);
    return deps.reply(`User ${code(userId)} is not a player in game ${code(gameId)}.`, { markdown: true });
  }
  addSubscription(deps.db, msg.chatId, gameId, userId, uname);
  log.info(`chat ${msg.chatId} registered ${userId} in ${gameId}`);
  return deps.reply(`Subscribed: you'll be notified on ${code(userId)}'s turn in ${code(gameId)}.`, {
    markdown: true,
  });
}
