import {
  DB,
  distinctGameIds,
  subscribersForGame,
  getGameState,
  setGameState,
  deleteGame,
} from './db';
import { GamePreview, GameNotFound, isUsersTurn, currentTurn, formatDuration } from './unciv';
import { Alerter } from './alerts';
import { log } from './log';

const failingGames = new Set<string>();

export interface PollDeps {
  db: DB;
  fetchPreview: (gameId: string) => Promise<GamePreview>;
  send: (chatId: number, text: string) => Promise<void>;
  alerter: Alerter;
  now?: () => number;
}

export async function pollGame(deps: PollDeps, gameId: string): Promise<void> {
  let preview: GamePreview;
  try {
    preview = await deps.fetchPreview(gameId);
  } catch (e) {
    if (e instanceof GameNotFound) {
      const subs = subscribersForGame(deps.db, gameId);
      for (const s of subs) {
        try {
          await deps.send(s.chat_id, `Game ${gameId} has finished or was removed.`);
        } catch (err) {
          await deps.alerter.telegramFailure(err);
        }
      }
      deleteGame(deps.db, gameId);
      failingGames.delete(gameId);
      deps.alerter.recordSuccess(gameId);
      log.info(`game ${gameId} gone, removed ${subs.length} subscription(s)`);
      return;
    }
    failingGames.add(gameId);
    log.warn(`poll failed for game ${gameId}: ${(e as Error).message}`);
    await deps.alerter.recordFailure(gameId, (e as Error).message);
    return;
  }

  deps.alerter.recordSuccess(gameId);
  if (failingGames.delete(gameId)) log.info(`game ${gameId} recovered`);

  const state = getGameState(deps.db, gameId);
  if (state && state.last_turns === preview.turns && state.last_current_player === preview.currentPlayer) {
    log.debug(`game ${gameId} checked, no change (turn ${preview.turns})`);
    return;
  }

  const ct = currentTurn(preview);
  const civName = ct?.civName ?? 'Unknown';
  // Only show a deadline when the turn start is known and force-resign is enabled.
  let deadlinePart = '';
  if (ct && ct.startedMs > 0 && ct.deadlineMs !== null) {
    const remaining = ct.deadlineMs - (deps.now ?? Date.now)();
    if (remaining > 0) deadlinePart = ` — ${formatDuration(remaining)} left to move`;
  }
  for (const s of subscribersForGame(deps.db, gameId)) {
    if (isUsersTurn(preview, s.user_id)) {
      try {
        await deps.send(s.chat_id, `🔔 It is ${civName}'s (${s.user_id}) turn in game ${gameId}${deadlinePart}.`);
        log.info(`notified ${s.user_id} for game ${gameId} (turn ${preview.turns})`);
      } catch (err) {
        await deps.alerter.telegramFailure(err);
      }
    }
  }

  setGameState(deps.db, gameId, preview.turns, preview.currentPlayer);
}

export async function pollOnce(deps: PollDeps): Promise<void> {
  for (const gameId of distinctGameIds(deps.db)) {
    await pollGame(deps, gameId);
  }
}

export function startPoller(deps: PollDeps, getIntervalMs: () => number): { stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async () => {
    try {
      await pollOnce(deps);
    } catch (e) {
      await deps.alerter.fatal(`poll loop error: ${(e as Error).message}`);
    }
    // tick() handles its own errors, so fire-and-forget is safe here.
    if (!stopped) timer = setTimeout(() => void tick(), getIntervalMs());
  };

  timer = setTimeout(() => void tick(), getIntervalMs());

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
