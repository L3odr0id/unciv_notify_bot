import { log } from './log';

export interface AlerterDeps {
  send: (chatId: number, text: string) => Promise<void>;
  adminChatIds: () => number[];
  now?: () => number;
  failThreshold?: number;
  tgThrottleMs?: number;
}

export class Alerter {
  private fails = new Map<string, number>();
  private alerted = new Set<string>();
  private lastTgAlert = -Infinity;
  private readonly now: () => number;
  private readonly failThreshold: number;
  private readonly tgThrottleMs: number;

  constructor(private deps: AlerterDeps) {
    this.now = deps.now ?? Date.now;
    this.failThreshold = deps.failThreshold ?? 3;
    this.tgThrottleMs = deps.tgThrottleMs ?? 600_000;
  }

  private async broadcast(text: string): Promise<void> {
    for (const chatId of this.deps.adminChatIds()) {
      try {
        await this.deps.send(chatId, text);
      } catch {
        // never let alert delivery throw into the caller
      }
    }
  }

  async recordFailure(gameId: string, reason: string): Promise<void> {
    const n = (this.fails.get(gameId) ?? 0) + 1;
    this.fails.set(gameId, n);
    if (n >= this.failThreshold && !this.alerted.has(gameId)) {
      this.alerted.add(gameId);
      const text = `⚠️ Game ${gameId} failing (${n}x): ${reason}`;
      log.warn(text);
      await this.broadcast(text);
    }
  }

  recordSuccess(gameId: string): void {
    this.fails.delete(gameId);
    this.alerted.delete(gameId);
  }

  async telegramFailure(err: unknown): Promise<void> {
    const t = this.now();
    if (t - this.lastTgAlert < this.tgThrottleMs) return;
    this.lastTgAlert = t;
    const text = `⚠️ Telegram send failure: ${(err as Error)?.message ?? err}`;
    log.warn(text);
    await this.broadcast(text);
  }

  async fatal(text: string): Promise<void> {
    const line = `🔥 FATAL: ${text}`;
    log.error(line);
    await this.broadcast(line);
  }
}
