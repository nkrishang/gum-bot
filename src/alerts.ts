import type { Bot } from './bot.ts';
import type { ActivityRow } from './db.ts';
import type { Runner } from './runner.ts';

/**
 * Pushes problems to a chat webhook so an unattended bot gets noticed. Works with Slack and Discord
 * incoming webhooks (the payload carries both `text` and `content`).
 *
 * Two kinds of alert:
 *  - Conditions, evaluated every 30 s: fire once when they start, remind hourly while they persist,
 *    and post "resolved" when they clear.
 *  - Events that are always worth a message (a paid deposit failing or expiring, a refused payment
 *    address), batched per kind so a burst becomes one message.
 */
export class Alerter {
  private active = new Map<string, { since: number; lastSent: number; text: string }>();
  private pendingSince = new Map<string, number>();
  private eventBatch = new Map<string, string[]>();
  private eventTimer?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private lastCreatedTotal = 0;
  private lastCreatedAt = Date.now();

  constructor(
    private readonly bot: Bot,
    private readonly runner: Runner,
    private readonly url: string | undefined,
    private readonly opts: { stuckSecs: number; idleSecs: number },
  ) {}

  start() {
    if (!this.url) return;
    this.lastCreatedTotal = this.bot.totals.created;
    const cap = this.bot.config.deposit.maxPerMinute;
    void this.send(
      `🟢 gum-bot started · ${this.bot.movers.length} movers on ${[...this.bot.chains.keys()].join(', ')}` +
        ` · ${cap ? `cap ${cap} deposits/min` : 'no rate cap'}${this.runner.paused ? ' · PAUSED' : ''}`,
    );
    this.bot.on('activity', (row: ActivityRow) => this.onActivity(row));
    this.timer = setInterval(() => this.evaluate(), 30_000);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.eventTimer);
  }

  private onActivity(row: ActivityRow) {
    const worthIt =
      row.kind === 'deposit.failed' ||
      (row.kind === 'deposit.expired' && row.level === 'error') || // expired after it was paid
      row.kind === 'verify.failed' ||
      row.kind === 'topup.insufficient' ||
      row.kind === 'cycle.error';
    if (!worthIt) return;
    const list = this.eventBatch.get(row.kind) ?? [];
    list.push(row.message);
    this.eventBatch.set(row.kind, list);
    this.eventTimer ??= setTimeout(() => this.flushEvents(), 10_000);
  }

  private flushEvents() {
    this.eventTimer = undefined;
    for (const [kind, messages] of this.eventBatch) {
      const head = messages.slice(0, 5).map((m) => `• ${m}`).join('\n');
      const more = messages.length > 5 ? `\n…and ${messages.length - 5} more` : '';
      void this.send(`🔴 ${messages.length} × ${kind}\n${head}${more}`);
    }
    this.eventBatch.clear();
  }

  /** Current problems, keyed so they can be tracked from firing to resolved. */
  private conditions(): Map<string, { text: string; graceSecs: number }> {
    const bot = this.bot;
    const now = Date.now();
    const out = new Map<string, { text: string; graceSecs: number }>();

    const stuck = [...bot.open.values()].filter((r) => r.pay_status === 'mined' && r.pay_mined_at && now - r.pay_mined_at > this.opts.stuckSecs * 1000);
    if (stuck.length) {
      const oldest = Math.max(...stuck.map((r) => now - r.pay_mined_at!)) / 1000;
      out.set('stuck', { text: `${stuck.length} paid deposit(s) not settled after ${this.opts.stuckSecs}s (oldest ${Math.round(oldest)}s, e.g. ${stuck[0]!.id})`, graceSecs: 0 });
    }

    if (bot.totals.created !== this.lastCreatedTotal) {
      this.lastCreatedTotal = bot.totals.created;
      this.lastCreatedAt = now;
    } else if (!this.runner.paused && now - this.lastCreatedAt > this.opts.idleSecs * 1000) {
      const why = this.runner.waiting ? Object.entries(this.runner.waiting.skipped).map(([k, v]) => `${k}: ${v}`).join(', ') : 'unknown';
      out.set('idle', { text: `no deposits created for ${Math.round((now - this.lastCreatedAt) / 60000)} min while running (movers sitting out: ${why})`, graceSecs: 0 });
    }

    const health = { no_gas: 0, no_token: 0 };
    for (const mv of bot.movers) {
      const h = bot.moverHealth(mv);
      if (h === 'no_gas' || h === 'no_token') health[h]++;
    }
    if (health.no_token) out.set('no_token', { text: `${health.no_token} mover(s) have no USDC (a stranded payment? run \`pnpm setup-movers\` to refill)`, graceSecs: 300 });
    if (health.no_gas) out.set('no_gas', { text: `${health.no_gas} mover(s) are out of gas`, graceSecs: 300 });

    for (const [slug, h] of bot.chainHealth) {
      const c = bot.chain(slug);
      if (!h.rpcOk) out.set(`rpc:${slug}`, { text: `${slug} RPC failing: ${h.lastError?.message ?? 'unknown error'}`, graceSecs: 120 });
      if (h.funder.native !== undefined && h.funder.native < c.funderMin) {
        out.set(`funder:${slug}`, { text: `funder low on ${slug}: ${Number(h.funder.native) / 1e18} ${c.nativeSymbol} (alert below ${c.config.funderMin})`, graceSecs: 0 });
      }
    }
    return out;
  }

  private evaluate() {
    const now = Date.now();
    const current = this.conditions();
    for (const [key, c] of current) {
      // A condition has to persist for its grace period before it alerts (brief blips are normal).
      const since = this.pendingSince.get(key) ?? now;
      this.pendingSince.set(key, since);
      if (now - since < c.graceSecs * 1000) continue;
      const a = this.active.get(key);
      if (!a) {
        this.active.set(key, { since, lastSent: now, text: c.text });
        void this.send(`🔴 ${c.text}`);
      } else if (now - a.lastSent > 60 * 60_000) {
        a.lastSent = now;
        void this.send(`🔴 still: ${c.text} (for ${Math.round((now - a.since) / 60000)} min)`);
      }
    }
    for (const key of [...this.pendingSince.keys()]) if (!current.has(key)) this.pendingSince.delete(key);
    for (const [key, a] of this.active) {
      if (current.has(key)) continue;
      this.active.delete(key);
      void this.send(`✅ resolved after ${Math.max(1, Math.round((now - a.since) / 60000))} min: ${a.text}`);
    }
  }

  private async send(text: string) {
    if (!this.url) return;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `[gum-bot] ${text}`, content: `[gum-bot] ${text}`.slice(0, 1900) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.bot.log.warn({ status: res.status }, 'alert webhook rejected the message');
    } catch (err) {
      this.bot.log.warn({ err: (err as Error).message }, 'alert webhook unreachable');
    }
  }
}
