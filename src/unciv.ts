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
  let obj: any;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new DecodeError('json parse failed');
  }
  if (
    typeof obj?.turns !== 'number' ||
    typeof obj?.currentPlayer !== 'string' ||
    !Array.isArray(obj?.civilizations)
  ) {
    throw new DecodeError('preview missing required fields');
  }
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    turns: obj.turns,
    currentPlayer: obj.currentPlayer,
    currentTurnStartTime: num(obj.currentTurnStartTime, 0),
    civilizations: (obj.civilizations as any[]).map((c) => ({
      civID: c.civID,
      civName: c.civName,
      playerId: c.playerId,
      playerType: c.playerType,
      // 0 means force-resign disabled; a missing field is treated the same.
      playerMinutesBeforeForceResign: num(c.playerMinutesBeforeForceResign, 0),
    })),
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
