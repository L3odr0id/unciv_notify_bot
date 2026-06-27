import zlib from 'node:zlib';

const SERVER = 'https://uncivserver.xyz';

export interface CivPreview {
  civID: string;
  civName: string;
  playerId: string;
  playerType: string;
  playerMinutesBeforeForceResign: number;
}

export interface GamePreview {
  turns: number;
  currentPlayer: string;
  currentTurnStartTime: number;
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
    typeof root.turns !== 'number' ||
    typeof root.currentPlayer !== 'string' ||
    !Array.isArray(root.civilizations)
  ) {
    throw new DecodeError('preview missing required fields');
  }
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    turns: root.turns,
    currentPlayer: root.currentPlayer,
    currentTurnStartTime: num(root.currentTurnStartTime, 0),
    civilizations: root.civilizations.map((raw) => {
      const c = rec(raw);
      return {
        civID: str(c.civID),
        civName: str(c.civName),
        playerId: str(c.playerId),
        playerType: str(c.playerType),
        // 0 means force-resign disabled; a missing field is treated the same.
        playerMinutesBeforeForceResign: num(c.playerMinutesBeforeForceResign, 0),
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

export function currentTurn(
  p: GamePreview,
): { civName: string; playerId: string; startedMs: number; deadlineMs: number | null } | null {
  const civ = p.civilizations.find((c) => c.civID === p.currentPlayer);
  if (!civ) return null;
  const forceResignMin = civ.playerMinutesBeforeForceResign;
  return {
    civName: civ.civName,
    playerId: civ.playerId,
    startedMs: p.currentTurnStartTime,
    // 0 (or missing) means force-resign is disabled — there is no deadline.
    deadlineMs: forceResignMin > 0 ? p.currentTurnStartTime + forceResignMin * 60000 : null,
  };
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
