import zlib from 'node:zlib';
import { code, esc } from './tg';

const SERVER = 'https://uncivserver.xyz';

// Unciv serializes previews with libGDX `Json` + `usePrototypes`, which omits any
// field equal to its class default. So an absent timer param means "default", not
// "disabled" (Unciv has no off switch — the lobby floors each at 3 minutes). These
// mirror GameParameters.kt and Civilization(InfoPreview) in the reference source.
export const DEFAULT_MINUTES_UNTIL_SKIP_TURN = 60 * 24; // 1440
export const DEFAULT_MINUTES_UNTIL_FORCE_RESIGN = 3 * 24 * 60; // 4320
export const DEFAULT_MINUTES_RECOVERED_PER_TURN = 60 * 24; // 1440
export const DEFAULT_PLAYER_MINUTES_BEFORE_FORCE_RESIGN = 3 * 24 * 60; // 4320

export interface CivPreview {
  civID: string;
  civName: string;
  playerId: string;
  playerType: string;
  playerMinutesBeforeForceResign: number;
}

export interface GameParams {
  minutesUntilSkipTurn: number;
  minutesUntilForceResign: number;
  minutesRecoveredPerTurn: number;
}

export interface GamePreview {
  turns: number | null;
  currentPlayer: string;
  currentTurnStartTime: number;
  gameParameters: GameParams;
  civilizations: CivPreview[];
}

export class GameNotFound extends Error {}
export class DecodeError extends Error {}

export function decodePreview(body: string): GamePreview {
  let json: string;
  try {
    json = zlib.gunzipSync(Buffer.from(body, 'base64')).toString('utf8');
  } catch (e) {
    throw new DecodeError(`gunzip/base64 failed: ${(e as Error).message}`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new DecodeError('json parse failed');
  }
  const rec = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const root = rec(obj);
  if (
    typeof root.currentPlayer !== 'string' ||
    !Array.isArray(root.civilizations)
  ) {
    throw new DecodeError('preview missing required fields');
  }
  if (root.turns !== undefined && typeof root.turns !== 'number') {
    throw new DecodeError('preview has invalid turns field');
  }
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const params = rec(root.gameParameters);
  return {
    turns: typeof root.turns === 'number' ? root.turns : null,
    currentPlayer: root.currentPlayer,
    currentTurnStartTime: num(root.currentTurnStartTime, 0),
    gameParameters: {
      minutesUntilSkipTurn: num(params.minutesUntilSkipTurn, DEFAULT_MINUTES_UNTIL_SKIP_TURN),
      minutesUntilForceResign: num(params.minutesUntilForceResign, DEFAULT_MINUTES_UNTIL_FORCE_RESIGN),
      minutesRecoveredPerTurn: num(params.minutesRecoveredPerTurn, DEFAULT_MINUTES_RECOVERED_PER_TURN),
    },
    civilizations: root.civilizations.map((raw) => {
      const c = rec(raw);
      return {
        civID: str(c.civID),
        civName: str(c.civName),
        playerId: str(c.playerId),
        playerType: str(c.playerType),
        // Absent means the field equals its default (libGDX omits defaults), i.e. a
        // full 3-day bank — not 0. An explicit 0 is kept (player is out of time).
        playerMinutesBeforeForceResign: num(
          c.playerMinutesBeforeForceResign,
          DEFAULT_PLAYER_MINUTES_BEFORE_FORCE_RESIGN,
        ),
      };
    }),
  };
}

export function isUsersTurn(p: GamePreview, userId: string): boolean {
  const civ = p.civilizations.find((c) => c.civID === p.currentPlayer);
  return !!civ && civ.playerId === userId;
}

export async function fetchPreview(
  gameId: string,
  fetchFn: typeof fetch = fetch,
): Promise<GamePreview> {
  const res = await fetchFn(`${SERVER}/files/${gameId}_Preview`);
  if (res.status === 404) throw new GameNotFound(gameId);
  if (!res.ok) throw new Error(`server responded ${res.status}`);
  return decodePreview(await res.text());
}

export function civForPlayer(p: GamePreview, userId: string): string | null {
  const civ = p.civilizations.find((c) => c.playerId === userId);
  return civ ? civ.civName : null;
}

export function currentTurn(p: GamePreview): TurnTimers | null {
  const civ = p.civilizations.find((c) => c.civID === p.currentPlayer);
  if (!civ) return null;
  const gp = p.gameParameters;
  const start = p.currentTurnStartTime;
  return {
    civName: civ.civName,
    playerId: civ.playerId,
    startedMs: start,
    skipDeadlineMs: gp.minutesUntilSkipTurn > 0 ? start + gp.minutesUntilSkipTurn * 60000 : null,
    totalDeadlineMs:
      gp.minutesUntilForceResign > 0 ? start + civ.playerMinutesBeforeForceResign * 60000 : null,
    recoveredPerTurnMin: gp.minutesRecoveredPerTurn,
  };
}

export interface TurnTimers {
  civName: string;
  playerId: string;
  startedMs: number;
  skipDeadlineMs: number | null;
  totalDeadlineMs: number | null;
  recoveredPerTurnMin: number;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  if (days > 0) {
    if (hours > 0 && minutes > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${days}d ${hours}h`;
    if (minutes > 0) return `${days}d ${minutes}m`;
    return `${days}d`;
  }
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** Remaining force-resign bank for a player, in minutes; null if disabled or not in game. */
export function playerResignBankMin(p: GamePreview, userId: string): number | null {
  if (p.gameParameters.minutesUntilForceResign <= 0) return null;
  const civ = p.civilizations.find((c) => c.playerId === userId);
  if (!civ) return null;
  return civ.playerMinutesBeforeForceResign;
}

export function formatTurnTimers(
  t: Pick<TurnTimers, 'skipDeadlineMs' | 'totalDeadlineMs' | 'recoveredPerTurnMin'>,
  now: number,
): string[] {
  const lines: string[] = [];
  if (t.skipDeadlineMs !== null) {
    const r = t.skipDeadlineMs - now;
    lines.push(`⏭ Skip in: ${r <= 0 ? 'can be skipped now' : formatDuration(r)}`);
  }
  if (t.totalDeadlineMs !== null) {
    const r = t.totalDeadlineMs - now;
    lines.push(`⏳ Kick in: ${r <= 0 ? 'overdue' : formatDuration(r)}`);
  }
  return lines;
}

/** Civs with a multiplayer user id, lowest resign bank first. */
export function blameBanks(p: GamePreview): { civName: string; playerId: string; bankMin: number; isCurrent: boolean }[] {
  if (p.gameParameters.minutesUntilForceResign <= 0) return [];
  return p.civilizations
    .filter((c) => c.playerId)
    .map((c) => ({
      civName: c.civName,
      playerId: c.playerId,
      bankMin: c.playerMinutesBeforeForceResign,
      isCurrent: c.civID === p.currentPlayer,
    }))
    .sort((a, b) => a.bankMin - b.bankMin || a.civName.localeCompare(b.civName));
}

export function formatBlame(p: GamePreview, gameId: string, now: number): string {
  const turnLine = p.turns === null ? 'Turn unknown' : `Turn ${p.turns}`;
  const ct = currentTurn(p);
  const header: string[] = [`Game ${code(gameId)}`, turnLine];
  if (ct) {
    let turn = `${esc(ct.civName)}'s turn`;
    if (ct.startedMs > 0) turn += ` - started ${formatDuration(now - ct.startedMs)} ago`;
    header.push(turn + '.');
    if (ct.startedMs > 0) {
      for (const l of formatTurnTimers(ct, now)) header.push(`   ${l}`);
    }
  }
  if (p.gameParameters.minutesUntilForceResign <= 0) {
    header.push('Force-resign is disabled for this game.');
    return header.join('\n');
  }
  const banks = blameBanks(p);
  if (banks.length === 0) {
    header.push('No human players found.');
    return header.join('\n');
  }
  header.push('Time before force-resign (lowest first):');
  for (const b of banks) {
    const mark = b.isCurrent ? ' ← current turn' : '';
    header.push(`   ${esc(b.civName)}: ${formatDuration(b.bankMin * 60000)}${mark}`);
  }
  return header.join('\n');
}
