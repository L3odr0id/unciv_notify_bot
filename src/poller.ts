import {
  DB,
  distinctGameIds,
  subscribersForGame,
  getGameState,
  setGameState,
  deleteGame,
} from './db';
import { GamePreview, GameNotFound, isUsersTurn, currentTurn, formatTurnTimers } from './unciv';
import { Alerter } from './alerts';
import { SendOpts, code, esc } from './tg';
import { log } from './log';

const failingGames = new Set<string>();

export interface PollDeps {
  db: DB;
  fetchPreview: (gameId: string) => Promise<GamePreview>;
  send: (chatId: number, text: string, opts?: SendOpts) => Promise<void>;
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
          await deps.send(s.chat_id, `Game ${code(gameId)} has finished or was removed.`, { markdown: true });
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

  const turnKey = preview.turns ?? preview.currentTurnStartTime;
  const turnLabel = preview.turns === null ? 'unknown' : String(preview.turns);
  const state = getGameState(deps.db, gameId);
  if (state && state.last_turns === turnKey && state.last_current_player === preview.currentPlayer) {
    log.debug(`game ${gameId} checked, no change (turn ${turnLabel})`);
    return;
  }

  const ct = currentTurn(preview);
  const civName = ct?.civName ?? 'Unknown';
  const now = (deps.now ?? Date.now)();
  const timerLines = ct && ct.startedMs > 0 ? formatTurnTimers(ct, now) : [];
  const suffix = timerLines.length ? '\n' + timerLines.map((l) => `   ${l}`).join('\n') : '';
  for (const s of subscribersForGame(deps.db, gameId)) {
    if (isUsersTurn(preview, s.user_id)) {
      try {
        await deps.send(
          s.chat_id,
          `🔔 It is ${esc(civName)}'s (${code(s.user_id)}) turn in game ${code(gameId)}.${suffix}`,
          { markdown: true },
        );
        log.info(`notified ${s.user_id} for game ${gameId} (turn ${turnLabel})`);
      } catch (err) {
        await deps.alerter.telegramFailure(err);
      }
    }
  }

  setGameState(deps.db, gameId, turnKey, preview.currentPlayer);
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
