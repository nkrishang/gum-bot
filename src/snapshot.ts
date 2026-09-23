import { formatUnits } from 'viem';
import type { Bot } from './bot.ts';
import type { DepositRow } from './db.ts';
import type { Runner, CycleState } from './runner.ts';
import type { Treasury } from './treasury.ts';

/**
 * The dashboard's view of the world, rebuilt once a second and pushed over SSE. Cheap parts are
 * computed every time; the database aggregates (latency percentiles, per-minute throughput) are
 * cached for a few seconds.
 */

const STAGES: Array<{ key: string; label: string; from: (r: DepositRow, s: Record<string, number>) => number | null | undefined; to: (r: DepositRow, s: Record<string, number>) => number | null | undefined }> = [
  { key: 'create', label: 'Create API', from: (r) => (r.create_ms != null ? r.created_at - r.create_ms : null), to: (r) => r.created_at },
  { key: 'dispatch', label: 'Sign & broadcast', from: (r) => r.created_at, to: (r) => r.pay_sent_at },
  { key: 'inclusion', label: 'Payment lands on-chain', from: (r) => r.pay_sent_at, to: (r) => r.pay_landed_at },
  { key: 'detect', label: 'Gum detects', from: (r) => r.pay_landed_at, to: (r) => r.detected_at },
  { key: 'confirm', label: 'Confirmations', from: (r) => r.detected_at, to: (r, s) => s['deposit.ready'] ?? r.ready_at },
  { key: 'submit', label: 'Settlement submit', from: (r, s) => s['deposit.ready'] ?? r.ready_at, to: (_r, s) => s['deposit.settlement_submitted'] },
  { key: 'include', label: 'Settlement inclusion', from: (_r, s) => s['deposit.settlement_submitted'], to: (_r, s) => s['deposit.settlement_included'] },
  { key: 'finalize', label: 'Settlement confirm', from: (_r, s) => s['deposit.settlement_included'], to: (r) => r.settled_at },
];

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

function summarize(values: number[]) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p90: pct(s, 90), p99: pct(s, 99), max: s.length ? s[s.length - 1]! : null };
}

export class SnapshotBuilder {
  private cache?: { at: number; latency: unknown; throughput: unknown; outcomes1h: unknown };

  constructor(
    private readonly bot: Bot,
    private readonly runner: Runner,
    private readonly treasury: Treasury,
  ) {}

  private aggregates() {
    const now = Date.now();
    if (this.cache && now - this.cache.at < 5_000) return this.cache;
    const bot = this.bot;
    const hourAgo = now - 3_600_000;
    const rows = bot.db.terminalSince(hourAgo, 5000);
    const settled = rows.filter((r) => r.status === 'settled');

    const byChain: Record<string, unknown> = {};
    for (const slug of bot.chains.keys()) {
      const rs = settled.filter((r) => r.chain === slug);
      byChain[slug] = {
        // The headline: payment landed at the address (block timestamp) → Gum marked it settled.
        settle: summarize(rs.filter((r) => r.pay_landed_at && r.settled_at).map((r) => Math.max(r.settled_at! - r.pay_landed_at!, 0))),
        detect: summarize(rs.filter((r) => r.pay_landed_at && r.detected_at).map((r) => Math.max(r.detected_at! - r.pay_landed_at!, 0))),
        e2e: summarize(rs.filter((r) => r.settled_at).map((r) => r.settled_at! - r.created_at)),
        inclusion: summarize(rs.filter((r) => r.pay_sent_at && r.pay_landed_at).map((r) => Math.max(r.pay_landed_at! - r.pay_sent_at!, 0))),
        // Bot-side only: how long after landing our own RPC reported the receipt. Not Gum latency.
        receiptLag: summarize(rs.filter((r) => r.pay_landed_at && r.pay_mined_at).map((r) => Math.max(r.pay_mined_at! - r.pay_landed_at!, 0))),
        create: summarize(rs.filter((r) => r.create_ms != null).map((r) => r.create_ms!)),
      };
    }

    const stages = STAGES.map((st) => {
      const perChain: Record<string, unknown> = {};
      const all: number[] = [];
      for (const slug of bot.chains.keys()) {
        const vals: number[] = [];
        for (const r of settled) {
          if (r.chain !== slug) continue;
          const s = r.stages ? (JSON.parse(r.stages) as Record<string, number>) : {};
          const a = st.from(r, s);
          const b = st.to(r, s);
          if (a != null && b != null) vals.push(Math.max(b - a, 0));
        }
        all.push(...vals);
        perChain[slug] = summarize(vals);
      }
      return { key: st.key, label: st.label, all: summarize(all), byChain: perChain };
    });

    const minutes = bot.db.minuteBuckets(now - 60 * 60_000);
    const outcomes1h: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      const o = (outcomes1h[r.chain] ??= {});
      o[r.status] = (o[r.status] ?? 0) + 1;
    }
    this.cache = { at: now, latency: { byChain, stages, sample: settled.length }, throughput: minutes, outcomes1h };
    return this.cache;
  }

  build() {
    const bot = this.bot;
    const now = Date.now();
    const cfg = bot.config;
    const agg = this.aggregates();
    const pendingTopups = new Set(this.treasury.pendingTopups());

    const chains = [...bot.chains.values()].map((c) => {
      const h = bot.chainHealth.get(c.slug)!;
      const movers = bot.movers.filter((mv) => mv.chain === c.slug);
      const open = [...bot.open.values()].filter((r) => r.chain === c.slug);
      return {
        slug: c.slug,
        chainId: c.chainId,
        nativeSymbol: c.nativeSymbol,
        explorerUrl: c.explorerUrl ?? null,
        token: c.token,
        gasMin: c.config.gasMin,
        gasTopup: c.config.gasTopup,
        funderMin: c.config.funderMin,
        block: h.block ?? null,
        rpcLatencyMs: h.rpcLatencyMs ?? null,
        rpc: { rate: c.rpcLimiter.recentRate, limit: c.config.rpcRps, queued: c.rpcLimiter.queued },
        rpcOk: h.rpcOk,
        rpcError: h.lastError ?? null,
        updatedAt: h.updatedAt ?? null,
        funder: {
          native: h.funder.native !== undefined ? formatUnits(h.funder.native, 18) : null,
          token: h.funder.token !== undefined ? formatUnits(h.funder.token, c.token.decimals) : null,
          low: h.funder.native !== undefined && h.funder.native < c.funderMin,
          topupsLeft: h.funder.native !== undefined && c.gasTopup > 0n ? Number(h.funder.native / c.gasTopup) : null,
        },
        movers: movers.length,
        open: open.length,
        totals: bot.perChain[c.slug],
      };
    });

    const movers = bot.movers.map((mv) => {
      const b = mv.balances[mv.chain];
      const chain = bot.chains.get(mv.chain);
      const active = mv.activeDeposit ? bot.open.get(mv.activeDeposit) : undefined;
      return {
        index: mv.index,
        address: mv.address,
        chain: mv.chain,
        preferredChain: mv.preferredChain,
        phase: mv.phase,
        health: bot.moverHealth(mv),
        enabled: mv.enabled,
        native: b?.native !== undefined ? formatUnits(b.native, 18) : null,
        token: b?.token !== undefined && chain ? formatUnits(b.token, chain.token.decimals) : null,
        gasRatio: b?.native !== undefined && chain && chain.gasMin > 0n ? Number((b.native * 1000n) / chain.gasMin) / 1000 : null,
        topupPending: pendingTopups.has(`${mv.chain}:${mv.index}`),
        active: active
          ? { id: active.id, status: active.status, pay: active.pay_status, since: active.created_at, tx: active.pay_tx }
          : null,
        last: mv.lastDeposit ?? null,
        error: mv.lastError ?? null,
        stats: mv.stats,
      };
    });

    const cycle = (c?: CycleState) =>
      c && {
        id: c.id,
        phase: c.phase,
        startedAt: c.startedAt,
        endedAt: c.endedAt ?? null,
        planned: c.planned,
        created: c.created,
        paid: c.paid,
        settled: c.settled,
        failed: c.failed,
        carried: c.carried,
        errors: c.errors,
        skipped: c.skipped,
        nextAt: c.nextAt ?? null,
      };

    const gumLatency: Record<string, unknown> = {};
    for (const [op, samples] of Object.entries(bot.gumStats.latency)) gumLatency[op] = summarize(samples.slice(-200));

    return {
      now,
      startedAt: bot.startedAt,
      runner: {
        paused: this.runner.paused,
        current: cycle(this.runner.current) ?? null,
        last: cycle(this.runner.last) ?? null,
        waiting: this.runner.waiting ?? null,
        rateCap: { limit: this.runner.rateCap.limit, used: this.runner.rateCap.used(), nextFreeAt: this.runner.rateCap.nextFreeAt() },
      },
      config: {
        apiUrl: cfg.gum.apiUrl,
        token: 'USDC',
        amount: cfg.deposit.amount.toString(),
        decimals: [...bot.chains.values()][0]?.token.decimals ?? 6,
        moverCount: bot.movers.length,
        rateLimitRps: cfg.gum.rateLimitRps,
        webhooks: Boolean(cfg.gum.webhookSecret && cfg.publicUrl),
        verifyAddresses: [...bot.verifyChains],
        cycleMinIntervalMs: cfg.cycle.minIntervalMs,
        settleTimeoutMs: cfg.cycle.settleTimeoutMs,
        funder: bot.funder.address,
      },
      gum: {
        rate: bot.gum.limiter.recentRate,
        queued: bot.gum.limiter.queued,
        requests: bot.gumStats.requests,
        byStatus: bot.gumStats.byStatus,
        latency: gumLatency,
        lastError: bot.gumStats.lastError ?? null,
      },
      totals: bot.totals,
      open: bot.open.size,
      chains,
      movers,
      latency: agg.latency,
      throughput: agg.throughput,
      outcomes1h: agg.outcomes1h,
      alerts: this.alerts(chains, movers),
      recentDeposits: bot.db.recentDeposits(40).map(depositView),
      activity: bot.recentActivity(80),
      cycles: bot.db.recentCycles(20),
      topups: bot.db.recentTopups(15),
    };
  }

  private alerts(chains: Array<{ slug: string; rpcOk: boolean; funder: { low: boolean; native: string | null }; nativeSymbol: string }>, movers: Array<{ health: string; index: number }>) {
    const out: Array<{ level: 'warn' | 'error'; message: string }> = [];
    for (const c of chains) {
      if (!c.rpcOk) out.push({ level: 'error', message: `${c.slug}: RPC unreachable` });
      if (c.funder.low) out.push({ level: 'warn', message: `${c.slug}: funder low (${Number(c.funder.native).toPrecision(4)} ${c.nativeSymbol})` });
    }
    const count = (h: string) => movers.filter((x) => x.health === h).length;
    if (count('no_token')) out.push({ level: 'error', message: `${count('no_token')} mover(s) have no USDC` });
    if (count('no_gas')) out.push({ level: 'error', message: `${count('no_gas')} mover(s) out of gas` });
    const stuck = [...this.bot.open.values()].filter((r) => r.pay_status === 'mined' && Date.now() - (r.pay_mined_at ?? r.created_at) > 10 * 60_000);
    if (stuck.length) out.push({ level: 'warn', message: `${stuck.length} paid deposit(s) unsettled for over 10 min` });
    if (this.runner.paused) out.push({ level: 'warn', message: 'runner is paused' });
    return out;
  }
}

export function depositView(r: DepositRow) {
  return {
    ...r,
    stages: r.stages ? (JSON.parse(r.stages) as Record<string, number>) : null,
    webhooks: r.webhooks ? (JSON.parse(r.webhooks) as Record<string, { receivedAt: number; lagMs: number }>) : null,
  };
}
