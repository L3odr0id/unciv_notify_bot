import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscriptions (
  chat_id INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (chat_id, game_id, user_id)
);
CREATE TABLE IF NOT EXISTS game_state (
  game_id TEXT PRIMARY KEY,
  last_turns INTEGER,
  last_current_player TEXT,
  last_notified_at INTEGER
);
CREATE TABLE IF NOT EXISTS admins (
  username TEXT PRIMARY KEY,
  chat_id INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS blocked_usernames (username TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS blocked_chats (chat_id INTEGER PRIMARY KEY);
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrateSchema(db);
  return db;
}

/** Additive migrations for existing on-disk DBs created before schema changes. */
export function migrateSchema(db: DB, now = Date.now()): void {
  const cols = db.prepare('PRAGMA table_info(game_state)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'last_notified_at')) {
    db.exec('ALTER TABLE game_state ADD COLUMN last_notified_at INTEGER');
    // Seed existing rows so an upgrade does not immediately re-notify everyone.
    db.prepare('UPDATE game_state SET last_notified_at = ? WHERE last_notified_at IS NULL').run(now);
  }
}

export function addSubscription(
  db: DB,
  chatId: number,
  gameId: string,
  userId: string,
  username = '',
): void {
  db.prepare(
    `INSERT INTO subscriptions (chat_id, game_id, user_id, username)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id, game_id, user_id) DO UPDATE SET username = excluded.username`,
  ).run(chatId, gameId, userId, username);
}

export function removeSubscription(
  db: DB,
  chatId: number,
  gameId: string,
  userId?: string,
): number {
  if (userId !== undefined) {
    return db
      .prepare('DELETE FROM subscriptions WHERE chat_id = ? AND game_id = ? AND user_id = ?')
      .run(chatId, gameId, userId).changes;
  }
  return db
    .prepare('DELETE FROM subscriptions WHERE chat_id = ? AND game_id = ?')
    .run(chatId, gameId).changes;
}

export function listSubscriptions(
  db: DB,
  chatId: number,
): { game_id: string; user_id: string }[] {
  return db
    .prepare('SELECT game_id, user_id FROM subscriptions WHERE chat_id = ? ORDER BY game_id')
    .all(chatId) as { game_id: string; user_id: string }[];
}

export function allSubscriptions(
  db: DB,
): { chat_id: number; username: string; game_id: string; user_id: string }[] {
  return db
    .prepare(
      'SELECT chat_id, username, game_id, user_id FROM subscriptions ORDER BY chat_id, game_id',
    )
    .all() as { chat_id: number; username: string; game_id: string; user_id: string }[];
}

export function distinctGameIds(db: DB): string[] {
  return (db.prepare('SELECT DISTINCT game_id FROM subscriptions').all() as { game_id: string }[]).map(
    (r) => r.game_id,
  );
}

export function subscribersForGame(
  db: DB,
  gameId: string,
): { chat_id: number; user_id: string }[] {
  return db
    .prepare('SELECT chat_id, user_id FROM subscriptions WHERE game_id = ?')
    .all(gameId) as { chat_id: number; user_id: string }[];
}

export type GameStateRow = {
  last_turns: number;
  last_current_player: string;
  last_notified_at: number | null;
};

export function getGameState(db: DB, gameId: string): GameStateRow | undefined {
  return db
    .prepare('SELECT last_turns, last_current_player, last_notified_at FROM game_state WHERE game_id = ?')
    .get(gameId) as GameStateRow | undefined;
}

export function setGameState(
  db: DB,
  gameId: string,
  turns: number,
  currentPlayer: string,
  lastNotifiedAt: number | null = null,
): void {
  db.prepare(
    `INSERT INTO game_state (game_id, last_turns, last_current_player, last_notified_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(game_id) DO UPDATE SET
       last_turns = excluded.last_turns,
       last_current_player = excluded.last_current_player,
       last_notified_at = excluded.last_notified_at`,
  ).run(gameId, turns, currentPlayer, lastNotifiedAt);
}

export function deleteGame(db: DB, gameId: string): void {
  db.prepare('DELETE FROM subscriptions WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM game_state WHERE game_id = ?').run(gameId);
}

export function upsertAdmin(db: DB, username: string, chatId: number): void {
  db.prepare(
    `INSERT INTO admins (username, chat_id) VALUES (?, ?)
     ON CONFLICT(username) DO UPDATE SET chat_id = excluded.chat_id`,
  ).run(username, chatId);
}

export function adminChatIds(db: DB): number[] {
  return (
    db.prepare('SELECT chat_id FROM admins WHERE chat_id IS NOT NULL').all() as {
      chat_id: number;
    }[]
  ).map((r) => r.chat_id);
}

export function getSetting(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function stats(db: DB): { games: number; subs: number; admins: number } {
  const games = (db.prepare('SELECT COUNT(DISTINCT game_id) AS n FROM subscriptions').get() as {
    n: number;
  }).n;
  const subs = (db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get() as { n: number }).n;
  const admins = (db.prepare('SELECT COUNT(*) AS n FROM admins').get() as { n: number }).n;
  return { games, subs, admins };
}

export function blockUsername(db: DB, username: string): void {
  db.prepare('INSERT OR IGNORE INTO blocked_usernames (username) VALUES (?)').run(username);
}

export function blockChat(db: DB, chatId: number): void {
  db.prepare('INSERT OR IGNORE INTO blocked_chats (chat_id) VALUES (?)').run(chatId);
}

export function unblockUsername(db: DB, username: string): number {
  return db.prepare('DELETE FROM blocked_usernames WHERE username = ?').run(username).changes;
}

export function unblockChat(db: DB, chatId: number): number {
  return db.prepare('DELETE FROM blocked_chats WHERE chat_id = ?').run(chatId).changes;
}

export function isBlocked(db: DB, chatId: number, username: string): boolean {
  const byChat = db.prepare('SELECT 1 FROM blocked_chats WHERE chat_id = ?').get(chatId);
  if (byChat) return true;
  if (username) {
    const byName = db.prepare('SELECT 1 FROM blocked_usernames WHERE username = ?').get(username);
    if (byName) return true;
  }
  return false;
}

export function removeByChat(db: DB, chatId: number): number {
  return db.prepare('DELETE FROM subscriptions WHERE chat_id = ?').run(chatId).changes;
}

export function removeByUsername(db: DB, username: string): number {
  return db.prepare('DELETE FROM subscriptions WHERE username = ?').run(username).changes;
}
