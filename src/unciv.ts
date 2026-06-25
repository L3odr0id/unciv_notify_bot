import zlib from 'node:zlib';

const SERVER = 'https://uncivserver.xyz';

export interface CivPreview {
  civID: string;
  civName: string;
  playerId: string;
  playerType: string;
}

export interface GamePreview {
  turns: number;
  currentPlayer: string;
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
  return {
    turns: obj.turns,
    currentPlayer: obj.currentPlayer,
    civilizations: obj.civilizations,
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
