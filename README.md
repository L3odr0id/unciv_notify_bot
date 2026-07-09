# Unciv Turn Notifier Bot

A Telegram bot [@unciv_notify_bot](https://t.me/unciv_notify_bot) that notifies 
[Unciv](https://github.com/yairm210/Unciv) multiplayer players when their turn starts.

Register a `game_id` + your Unciv multiplayer `user_id` and the bot polls the
multiplayer server. The moment your civilization becomes the current player, it
sends you a Telegram message.

### Unciv turn timers

- **Skip turn** — after a fixed number of minutes on the current turn, other players can skip it.
- **Force resign** — each player has a personal time bank. After that many minutes on *their* turn, other players can force-resign them. On turn end Unciv updates it as `newBank = oldBank + timeSpent − recoverPerTurn` (capped at the game max; no recover if the turn was skipped).

`/list` shows both for the current turn, plus your remaining resign bank. `/blame <game_id>` lists every player's resign bank.

## User commands

| Command | Description |
| --- | --- |
| `/subscribe <game_id> <user_id>` | Register a subscription. Validates that `user_id` (your Unciv multiplayer User ID / UUID) is a player in the game via the live preview. The only way to subscribe. |
| `/start` | Welcome message and basic instructions. |
| `/help` | All available commands and formats. |
| `/list` | Subscriptions with live turn status: current civ, how long the turn has been open, when others can skip / force-resign the current player, and your personal remaining force-resign bank. |
| `/blame <game_id>` | Live force-resign time banks for every player in the game (lowest first), plus current-turn skip/kick timers. |
| `/unsubscribe <game_id> [user_id]` | Remove a subscription. Without `user_id`, removes all subscriptions for that game in this chat; with it, removes only that `(game, user)` pair. |
| `/getinterval` | Current polling interval in seconds. |

## Admin commands

Admins are the Telegram handles listed in `ADMIN_USERNAMES`.

| Command | Description |
| --- | --- |
| `/setinterval <seconds>` | Set the polling interval (min 10s). |
| `/stats` | Aggregate stats: games, subscriptions, admins. |
| `/block <@handle\|chat_id>` | Block a user (by handle or chat id) from registering new subscriptions and remove their existing ones. |
| `/unblock <@handle\|chat_id>` | Unblock a previously blocked user. |

## Configuration

Fill `.env` (see `.env.example`):

## Run (Docker)

```bash
docker compose up -d --build
```

First run creates `${DATA_DIR}/subscriptions.db`; later runs reconnect to it.

## How it works

The Unciv multiplayer server is a plain file store, so the bot replicates what the
game client does:

1. Fetches the small game **preview** (`GET {server}/files/{gameId}_Preview`).
2. Decodes it (base64 → gunzip → JSON).
3. Finds the civ whose `civID === currentPlayer` and checks its `playerId`
   against each subscriber's `user_id`.
4. Notifies on the transition **into** a user's turn — detected when
   `(turns, currentPlayer)` changes from the last seen value for that game.

Default server: `https://uncivserver.xyz`. Games shared by multiple subscribers
are fetched once per poll.

## Develop

```bash
npm install
npm test          # tsx --test src/*.test.ts
npm run build     # tsc → dist/
npm start         # node dist/index.js
```
