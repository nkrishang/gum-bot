/**
 * Client-side token bucket mirroring Gum's per-key limiter (50/s, burst 100) with headroom, so the
 * bot never burns its budget on 429s. Waiters are served strictly in arrival order.
 */
export class TokenBucket {
  private tokens: number;
  private last = performance.now();
  private queue: Array<() => void> = [];
  private timer: NodeJS.Timeout | undefined;
  /** Requests admitted during the current and previous second, for the dashboard's usage gauge. */
  private window: number[] = [];

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  /** Resolves when a request may be sent. */
  take(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  /** Non-blocking: takes a token if one is available right now (server-side limiting). */
  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    this.window.push(performance.now());
    return true;
  }

  /** After a 429, drain the bucket so the next requests wait at least `ms`. */
  penalize(ms: number) {
    this.refill();
    this.tokens = Math.min(this.tokens, -((ms / 1000) * this.ratePerSec));
  }

  get queued() {
    return this.queue.length;
  }

  /** Requests admitted in the last second. */
  get recentRate() {
    const cutoff = performance.now() - 1000;
    this.window = this.window.filter((t) => t > cutoff);
    return this.window.length;
  }

  private refill() {
    const now = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
  }

  private drain() {
    this.refill();
    while (this.queue.length && this.tokens >= 1) {
      this.tokens -= 1;
      this.window.push(performance.now());
      this.queue.shift()!();
    }
    if (this.queue.length && !this.timer) {
      const waitMs = Math.max(((1 - this.tokens) / this.ratePerSec) * 1000, 1);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.drain();
      }, waitMs);
    }
  }
}
