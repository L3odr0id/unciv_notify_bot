import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscriptions (
  chat_id INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (chat_id, game_id, user_id)
);
CREATE TABLE IF NOT EXISTS game_state (
  game_id TEXT PRIMARY KEY,
  last_turns INTEGER,
  last_current_player TEXT
);
CREATE TABLE IF NOT EXISTS admins (
  username TEXT PRIMARY KEY,
  chat_id INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function addSubscription(db: DB, chatId: number, gameId: string, userId: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO subscriptions (chat_id, game_id, user_id) VALUES (?, ?, ?)',
  ).run(chatId, gameId, userId);
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

export function getGameState(
  db: DB,
  gameId: string,
): { last_turns: number; last_current_player: string } | undefined {
  return db
    .prepare('SELECT last_turns, last_current_player FROM game_state WHERE game_id = ?')
    .get(gameId) as { last_turns: number; last_current_player: string } | undefined;
}

export function setGameState(db: DB, gameId: string, turns: number, currentPlayer: string): void {
  db.prepare(
    `INSERT INTO game_state (game_id, last_turns, last_current_player)
     VALUES (?, ?, ?)
     ON CONFLICT(game_id) DO UPDATE SET last_turns = excluded.last_turns, last_current_player = excluded.last_current_player`,
  ).run(gameId, turns, currentPlayer);
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
