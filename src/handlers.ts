import {
  DB,
  addSubscription,
  removeSubscription,
  listSubscriptions,
  upsertAdmin,
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
import { GamePreview, GameNotFound, currentTurn } from './unciv';
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

const REGISTER_RE = /Game:\s*(\S+)\s+User:\s*(\S+)/i;
export function parseRegister(text: string): { gameId: string; userId: string } | null {
  const m = text.match(REGISTER_RE);
  return m ? { gameId: m[1], userId: m[2] } : null;
}

// A bare integer (optionally negative — Telegram group chat ids are negative) is a chat id; anything else is a handle.
function parseBlockTarget(arg: string): { kind: 'chat'; chatId: number } | { kind: 'user'; username: string } {
  if (/^-?\d+$/.test(arg)) return { kind: 'chat', chatId: Number(arg) };
  return { kind: 'user', username: normalizeUsername(arg) };
}

export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

export const MIN_INTERVAL_SECONDS = 10;

export const USAGE = [
  'Unciv turn-notifier bot.',
  '',
  'Subscribe with:',
  '  Game: <game_id> User: <user_id>',
  '',
  'Commands:',
  '  /list — your subscriptions',
  '  /my_subs — your subscriptions with live turn status',
  '  /unsubscribe <game_id> [user_id] — stop notifications',
].join('\n');

export interface IncomingMsg {
  chatId: number;
  username?: string;
  text: string;
}

export interface HandlerDeps {
  db: DB;
  adminSet: Set<string>;
  now: () => number;
  fetchPreview: (gameId: string) => Promise<GamePreview>;
  reply: (text: string) => Promise<void>;
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
    return deps.reply(subs.map((s) => `• ${s.game_id} — ${s.user_id}`).join('\n'));
  }

  if (text === '/my_subs') {
    const subs = listSubscriptions(deps.db, msg.chatId);
    if (subs.length === 0) return deps.reply('No subscriptions.');
    const games = [...new Set(subs.map((s) => s.game_id))];
    const lines = await Promise.all(
      games.map(async (gameId) => {
        try {
          const preview = await deps.fetchPreview(gameId);
          const ct = currentTurn(preview);
          if (!ct) return `Game ${gameId} — turn unknown.`;
          let line = `Game ${gameId} — ${ct.civName}'s turn (player ${ct.playerId}).`;
          if (ct.startedMs > 0) {
            const now = deps.now();
            const remaining = ct.deadlineMs - now;
            const deadline = remaining <= 0 ? 'overdue' : `in ${formatDuration(remaining)}`;
            line += ` Started ${formatDuration(now - ct.startedMs)} ago, deadline ${deadline}.`;
          }
          return line;
        } catch (e) {
          if (e instanceof GameNotFound) return `Game ${gameId} — finished or deleted.`;
          return `Game ${gameId} — server unreachable, try later.`;
        }
      }),
    );
    return deps.reply(`Your subscriptions:\n\n${lines.join('\n')}`);
  }

  if (text.startsWith('/unsubscribe')) {
    const [, gameId, userId] = text.split(/\s+/);
    if (!gameId) return deps.reply('Usage: /unsubscribe <game_id> [user_id]');
    const removed = removeSubscription(deps.db, msg.chatId, gameId, userId);
    if (removed > 0) log.info(`chat ${msg.chatId} unsubscribed ${gameId} (${removed})`);
    return deps.reply(removed > 0 ? `Removed ${removed} subscription(s).` : 'Nothing to remove.');
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
      .map((s) => `${s.chat_id} | @${s.username || '?'} | ${s.game_id} | ${s.user_id}`);
    if (subs.length > 50) lines.push(`…and ${subs.length - 50} more.`);
    return deps.reply(lines.join('\n'));
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

  const reg = parseRegister(text);
  if (reg) {
    const uname = normalizeUsername(msg.username ?? '');
    if (isBlocked(deps.db, msg.chatId, uname)) return deps.reply('You are blocked.');
    let preview: GamePreview;
    try {
      preview = await deps.fetchPreview(reg.gameId);
    } catch (e) {
      if (e instanceof GameNotFound) return deps.reply(`Game ${reg.gameId} not found.`);
      return deps.reply('Could not reach the Unciv server, try again later.');
    }
    if (!preview.civilizations.some((c) => c.playerId === reg.userId)) {
      log.debug(`register rejected: ${reg.userId} not in ${reg.gameId}`);
      return deps.reply(`User ${reg.userId} is not a player in game ${reg.gameId}.`);
    }
    addSubscription(deps.db, msg.chatId, reg.gameId, reg.userId, uname);
    log.info(`chat ${msg.chatId} registered ${reg.userId} in ${reg.gameId}`);
    return deps.reply(`Subscribed: you'll be notified on ${reg.userId}'s turn in ${reg.gameId}.`);
  }

  return deps.reply(USAGE);
}
