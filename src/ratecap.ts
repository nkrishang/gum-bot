/**
 * Hard ceiling on deposit creation: at most `limit` creations in any rolling window (default 60 s),
 * as Gum sees them. Bursts are fine; the window only ever admits `limit`. A limit of 0 means no cap.
 *
 * Gum timestamps a deposit somewhere between our request leaving and its response arriving, so a slot
 * is held from the request until `complete()` stamps the response time, and only frees `windowMs`
 * after that. Whatever the latency jitter, two deposits sharing a slot are then at least a full
 * window apart on Gum's clock too. A request still in flight never frees its slot.
 */
export class RateCap {
  private entries: Array<{ t: number; pending: boolean }>;

  constructor(
    readonly limit: number,
    readonly windowMs = 60_000,
    /** Creation times already in the window, e.g. from before a restart. */
    seed: number[] = [],
  ) {
    this.entries = seed.map((t) => ({ t, pending: false }));
  }

  get enabled() {
    return this.limit > 0;
  }

  private prune(now: number) {
    const cutoff = now - this.windowMs;
    this.entries = this.entries.filter((e) => e.pending || e.t > cutoff);
  }

  /** Slots held in the current window (including requests still in flight). */
  used(now = Date.now()) {
    this.prune(now);
    return this.entries.length;
  }

  /** How many more may be created right now. */
  available(now = Date.now()) {
    if (!this.enabled) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.limit - this.used(now));
  }

  /** When the next slot opens (now if one is free; +1 s while only in-flight requests hold slots). */
  nextFreeAt(now = Date.now()) {
    if (this.available(now) > 0) return now;
    const done = this.entries.filter((e) => !e.pending).map((e) => e.t).sort((a, b) => a - b);
    const excess = this.entries.length - this.limit; // how many must leave before one slot is free
    return excess < done.length ? done[excess]! + this.windowMs : now + 1_000;
  }

  /** Takes a slot for a request about to be sent. Call `complete()` when its response arrives. */
  record(now = Date.now()): { complete: (at?: number) => void } {
    const entry = { t: now, pending: true };
    this.entries.push(entry);
    return {
      complete: (at = Date.now()) => {
        entry.t = Math.max(entry.t, at);
        entry.pending = false;
      },
    };
  }
}
