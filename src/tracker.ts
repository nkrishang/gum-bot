import type { Bot } from './bot.ts';
import { sleep, type GumDeposit } from './gum.ts';

const RECENT_WINDOW_MS = 20 * 60_000;
const STRAGGLER_INTERVAL_MS = 30_000;
const MAX_LIST_PAGES = 5;

/**
 * Follows every open deposit to a terminal status by polling Gum.
 *
 * Recent deposits are covered by one `GET /v1/deposit?created_after=…&limit=200` per poll, whatever
 * their number, so tracking 50 deposits costs one request, not fifty. Older stragglers (stuck or
 * awaiting expiry) are polled individually and less often. When a deposit finishes, its full event
 * timeline is fetched once for the per-stage latency breakdown.
 *
 * Webhooks, when configured, feed the same {@link Bot.applyGumDeposit}; polling stays on as the
 * source of truth, so a lost webhook only costs latency.
 */
export class Tracker {
  private stopping = false;
  private lastStragglerPoll = new Map<string, number>();
  private eventQueue: string[] = [];
  private eventWorker?: Promise<void>;
  private wake?: () => void;

  constructor(private readonly bot: Bot) {}

  start() {
    void this.loop();
  }

  stop() {
    this.stopping = true;
    this.wake?.();
  }

  /** Poll now instead of waiting for the interval, e.g. right after a cycle's payments land. */
  poke() {
    this.wake?.();
  }

  enqueueEvents(id: string) {
    if (!this.bot.config.fetchDepositEvents) return;
    this.eventQueue.push(id);
    this.eventWorker ??= this.drainEvents().finally(() => (this.eventWorker = undefined));
  }

  private async loop() {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (err) {
        this.bot.log.warn({ err: (err as Error).message }, 'status poll failed');
        this.bot.gumStats.lastError = { message: (err as Error).message, at: Date.now() };
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.bot.config.cycle.pollIntervalMs);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }

  async pollOnce() {
    const bot = this.bot;
    if (bot.open.size === 0) return;
    const now = Date.now();
    const rows = [...bot.open.values()];
    const recent = rows.filter((r) => now - r.created_at < RECENT_WINDOW_MS);
    const old = rows.filter((r) => now - r.created_at >= RECENT_WINDOW_MS);

    if (recent.length) {
      const oldest = Math.min(...recent.map((r) => r.gum_created_at ?? r.created_at));
      const ids = new Set(recent.map((r) => r.id));
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES && ids.size; page++) {
        const res = await bot.gum.listDeposits({
          created_after: new Date(oldest - 60_000).toISOString(),
          limit: 200,
          cursor,
        });
        for (const d of res.items) {
          if (ids.delete(d.id)) bot.applyGumDeposit(d, 'poll');
        }
        cursor = res.next_cursor;
        if (!cursor) break;
      }
    }

    for (const r of old) {
      if (this.stopping) break;
      if (now - (this.lastStragglerPoll.get(r.id) ?? 0) < STRAGGLER_INTERVAL_MS) continue;
      this.lastStragglerPoll.set(r.id, now);
      try {
        bot.applyGumDeposit(await bot.gum.getDeposit(r.id), 'poll');
      } catch (err) {
        bot.log.warn({ deposit: r.id, err: (err as Error).message }, 'straggler poll failed');
      }
    }
    for (const id of this.lastStragglerPoll.keys()) if (!bot.open.has(id)) this.lastStragglerPoll.delete(id);
  }

  private async drainEvents() {
    while (this.eventQueue.length && !this.stopping) {
      // Low priority: leave the rate budget to deposit creation when a cycle is dispatching.
      if (this.bot.gum.limiter.queued > 0) {
        await sleep(250);
        continue;
      }
      const id = this.eventQueue.shift()!;
      try {
        const d: GumDeposit = await this.bot.gum.getDeposit(id);
        this.bot.applyGumDeposit(d, 'fetch');
      } catch (err) {
        this.bot.log.debug({ deposit: id, err: (err as Error).message }, 'event fetch failed');
      }
    }
  }
}
