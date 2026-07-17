import TelegramBot from 'node-telegram-bot-api';
import type { Message } from 'node-telegram-bot-api';
import { DB, openDb, getSetting, adminChatIds, distinctGameIds } from './db';
import { Alerter } from './alerts';
import { handleMessage, parseAdminSet } from './handlers';
import {
  MIN_INTERVAL_SECONDS,
  DEFAULT_INTERVAL_SECONDS,
  MIN_NOTIFY_PERIOD_SECONDS,
  DEFAULT_NOTIFY_PERIOD_SECONDS,
} from './constants';
import { fetchPreview } from './unciv';
import { startPoller } from './poller';
import { SendOpts } from './tg';
import { log } from './log';

export function resolveIntervalMs(db: DB, fallbackSeconds: number): number {
  const stored = getSetting(db, 'poll_interval_seconds');
  const chosen = Number.isFinite(Number(stored)) ? Number(stored) : fallbackSeconds;
  const safe = Math.max(chosen, MIN_INTERVAL_SECONDS);
  return safe * 1000;
}

export function resolveNotifyPeriodMs(db: DB, fallbackSeconds: number): number {
  const stored = getSetting(db, 'notify_period_seconds');
  const chosen = Number.isFinite(Number(stored)) ? Number(stored) : fallbackSeconds;
  const safe = Math.max(chosen, MIN_NOTIFY_PERIOD_SECONDS);
  return safe * 1000;
}

export function main(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

  const fallbackSeconds =
    Number(process.env.POLL_INTERVAL_SECONDS ?? DEFAULT_INTERVAL_SECONDS) || DEFAULT_INTERVAL_SECONDS;
  const fallbackNotifyPeriodSeconds =
    Number(process.env.NOTIFY_PERIOD_SECONDS ?? DEFAULT_NOTIFY_PERIOD_SECONDS) ||
    DEFAULT_NOTIFY_PERIOD_SECONDS;
  const adminSet = parseAdminSet(process.env.ADMIN_USERNAMES);

  const dbPath = process.env.DATABASE_PATH ?? './subscriptions.db';
  const db = openDb(dbPath);
  const bot = new TelegramBot(token, { polling: true });

  const send = (chatId: number, text: string, opts?: SendOpts) =>
    bot.sendMessage(chatId, text, opts?.markdown ? { parse_mode: 'Markdown' } : undefined).then(() => undefined);
  const alerter = new Alerter({ send, adminChatIds: () => adminChatIds(db) });

  bot.on('message', (msg: Message) => {
    if (!msg.text) return;
    handleMessage(
      {
        db,
        adminSet,
        fallbackIntervalSeconds: fallbackSeconds,
        fallbackNotifyPeriodSeconds,
        now: () => Date.now(),
        fetchPreview,
        reply: (t, opts) => send(msg.chat.id, t, opts),
      },
      { chatId: msg.chat.id, username: msg.from?.username, text: msg.text },
    ).catch((e: Error) => alerter.fatal(`handler error: ${e.message}`));
  });

  bot.on('polling_error', (e: Error) => {
    void alerter.telegramFailure(e);
  });

  startPoller(
    {
      db,
      fetchPreview,
      send,
      alerter,
      now: () => Date.now(),
      getNotifyPeriodMs: () => resolveNotifyPeriodMs(db, fallbackNotifyPeriodSeconds),
    },
    () => resolveIntervalMs(db, fallbackSeconds),
  );

  log.info(
    `bot started: server=https://uncivserver.xyz intervalSeconds=${fallbackSeconds} ` +
      `notifyPeriodSeconds=${fallbackNotifyPeriodSeconds} ` +
      `dbPath=${dbPath} admins=${adminSet.size} games=${distinctGameIds(db).length}`,
  );
}

if (require.main === module) {
  main();
}
