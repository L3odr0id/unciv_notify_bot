import TelegramBot from 'node-telegram-bot-api';
import type { Message } from 'node-telegram-bot-api';
import { DB, openDb, getSetting, adminChatIds, distinctGameIds } from './db';
import { Alerter } from './alerts';
import {
  handleMessage,
  parseAdminSet,
  MIN_INTERVAL_SECONDS,
} from './handlers';
import { fetchPreview } from './unciv';
import { startPoller } from './poller';
import { log } from './log';

export function resolveIntervalMs(db: DB, fallbackSeconds: number): number {
  const stored = getSetting(db, 'poll_interval_seconds');
  const chosen = Number.isFinite(Number(stored)) ? Number(stored) : fallbackSeconds;
  const safe = Math.max(chosen, MIN_INTERVAL_SECONDS);
  return safe * 1000;
}

export function main(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

  const fallbackSeconds = Number(process.env.POLL_INTERVAL_SECONDS ?? '60') || 60;
  const adminSet = parseAdminSet(process.env.ADMIN_USERNAMES);

  const dbPath = process.env.DATABASE_PATH ?? './subscriptions.db';
  const db = openDb(dbPath);
  const bot = new TelegramBot(token, { polling: true });

  const send = (chatId: number, text: string) => bot.sendMessage(chatId, text).then(() => undefined);
  const alerter = new Alerter({ send, adminChatIds: () => adminChatIds(db) });

  bot.on('message', (msg: Message) => {
    if (!msg.text) return;
    handleMessage(
      { db, adminSet, now: () => Date.now(), fetchPreview, reply: (t) => send(msg.chat.id, t) },
      { chatId: msg.chat.id, username: msg.from?.username, text: msg.text },
    ).catch((e: Error) => alerter.fatal(`handler error: ${e.message}`));
  });

  bot.on('polling_error', (e: Error) => {
    void alerter.telegramFailure(e);
  });

  startPoller({ db, fetchPreview, send, alerter }, () => resolveIntervalMs(db, fallbackSeconds));

  log.info(
    `bot started: server=https://uncivserver.xyz intervalSeconds=${fallbackSeconds} ` +
      `dbPath=${dbPath} admins=${adminSet.size} games=${distinctGameIds(db).length}`,
  );
}

if (require.main === module) {
  main();
}
