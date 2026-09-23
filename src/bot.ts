import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { formatUnits, type Account } from 'viem';
import type { ChainRuntime } from './chains.ts';
import type { ChainSlug, Config } from './config.ts';
import type { ActivityRow, Db, DepositRow } from './db.ts';
import { TERMINAL, type DepositStatus, type GumClient, type GumDeposit } from './gum.ts';
import type { Logger } from './log.ts';
import { m } from './metrics.ts';

export type MoverPhase = 'idle' | 'creating' | 'paying' | 'settling';
export type MoverHealth = 'ok' | 'low_gas' | 'no_gas' | 'no_token' | 'error' | 'disabled' | 'unknown';

export interface Balance {
  native?: bigint;
  token?: bigint;
  at: number;
}

export interface MoverState {
  index: number;
  account: Account;
  address: `0x${string}`;
  preferredChain: ChainSlug;
  /** The chain this mover pays on; the preferred one unless its USDC sits elsewhere. */
  chain: ChainSlug;
  balances: Partial<Record<ChainSlug, Balance>>;
  phase: MoverPhase;
  enabled: boolean;
  activeDeposit?: string;
  lastError?: { message: string; at: number };
  lastDeposit?: { id: string; status: string; at: number };
  stats: { created: number; paid: number; settled: number; failed: number; expired: number; errors: number; topups: number };
}

export interface Totals {
  created: number;
  createErrors: number;
  paid: number;
  payErrors: number;
  detected: number;
  settled: number;
  failed: number;
  expired: number;
  expiredUnpaid: number;
  /** Base units, as a string (bigint). */
  volumeSettled: string;
  topups: number;
  topupErrors: number;
  addressMismatch: number;
  cycles: number;
  webhooks: number;
}

const emptyTotals = (): Totals => ({
  created: 0,
  createErrors: 0,
  paid: 0,
  payErrors: 0,
  detected: 0,
  settled: 0,
  failed: 0,
  expired: 0,
  expiredUnpaid: 0,
  volumeSettled: '0',
  topups: 0,
  topupErrors: 0,
  addressMismatch: 0,
  cycles: 0,
  webhooks: 0,
});

export interface ChainHealth {
  block?: number;
  rpcLatencyMs?: number;
  rpcOk: boolean;
  lastError?: { message: string; at: number };
  updatedAt?: number;
  funder: Balance;
}

export interface GumApiStats {
  requests: number;
  byStatus: Record<string, number>;
  /** Rolling latency samples per op (ms). */
  latency: Record<string, number[]>;
  lastError?: { message: string; at: number };
}

/**
 * Shared state of the running bot: movers, chains, open deposits, counters and the activity feed.
 * The runner, tracker and treasury mutate it; the HTTP layer reads it. Every deposit status change
 * goes through {@link Bot.applyGumDeposit}, whichever source (poll, webhook, fetch) observed it.
 */
export class Bot extends EventEmitter {
  readonly bootId = randomBytes(4).toString('hex');
  readonly startedAt = Date.now();
  readonly chains = new Map<ChainSlug, ChainRuntime>();
  readonly chainHealth = new Map<ChainSlug, ChainHealth>();
  readonly movers: MoverState[];
  /** Non-terminal deposits, mirrored to the database. */
  readonly open = new Map<string, DepositRow>();
  totals: Totals;
  perChain: Record<string, Totals>;
  readonly gumStats: GumApiStats = { requests: 0, byStatus: {}, latency: {} };
  factory?: `0x${string}`;
  /** Chains where the factory has code, so payment addresses can be verified before paying. */
  readonly verifyChains = new Set<ChainSlug>();
  private activityBuffer: ActivityRow[] = [];

  constructor(
    readonly config: Config,
    readonly db: Db,
    readonly gum: GumClient,
    readonly log: Logger,
    readonly funder: Account,
    moverAccounts: Account[],
    readonly onDepositTerminal: (row: DepositRow) => void = () => {},
  ) {
    super();
    this.setMaxListeners(100);
    const rotation = config.moverChainRotation;
    const disabled = new Set(db.getKv<number[]>('disabled_movers') ?? []);
    this.movers = moverAccounts.map((account, index) => {
      const preferred = rotation[index % rotation.length]!;
      return {
        index,
        account,
        address: account.address,
        preferredChain: preferred,
        chain: preferred,
        balances: {},
        phase: 'idle',
        enabled: !disabled.has(index),
        stats: { created: 0, paid: 0, settled: 0, failed: 0, expired: 0, errors: 0, topups: 0 },
      };
    });
    const moverStats = db.getKv<Record<number, MoverState['stats']>>('mover_stats') ?? {};
    for (const mv of this.movers) if (moverStats[mv.index]) mv.stats = { ...mv.stats, ...moverStats[mv.index] };
    this.totals = { ...emptyTotals(), ...db.getKv<Totals>('totals') };
    const perChain = db.getKv<Record<string, Totals>>('per_chain') ?? {};
    this.perChain = {};
    for (const c of config.chains) this.perChain[c.slug] = { ...emptyTotals(), ...perChain[c.slug] };
    this.activityBuffer = db.recentActivity(200).reverse();
  }

  addChain(rt: ChainRuntime) {
    this.chains.set(rt.slug, rt);
    this.chainHealth.set(rt.slug, { rpcOk: false, funder: { at: 0 } });
  }

  chain(slug: ChainSlug): ChainRuntime {
    const c = this.chains.get(slug);
    if (!c) throw new Error(`chain ${slug} is not enabled`);
    return c;
  }

  /** Restores deposits left open by a previous run so they are tracked to completion. */
  restoreOpenDeposits() {
    for (const row of this.db.openDeposits()) {
      this.open.set(row.id, row);
      const mover = this.movers[row.mover];
      // Only an actually paid deposit ties up the mover's USDC.
      if (mover && mover.address.toLowerCase() === row.mover_address.toLowerCase() && row.pay_status !== 'failed' && row.pay_status !== 'skipped') {
        if (row.pay_status === 'pending') {
          // Crashed between create and broadcast: the transfer may or may not have gone out. The
          // mover's balance decides on the next refresh; the deposit itself expires on Gum's side.
          this.db.updateDeposit(row.id, { pay_status: 'skipped', pay_error: 'interrupted by restart before broadcast' });
          row.pay_status = 'skipped';
          continue;
        }
        mover.activeDeposit = row.id;
        mover.phase = 'settling';
        mover.chain = row.chain as ChainSlug;
      }
    }
    if (this.open.size) this.activity('info', 'restore', `resuming ${this.open.size} open deposits from the previous run`);
  }

  // ---- activity feed ------------------------------------------------------------------------

  activity(level: ActivityRow['level'], kind: string, message: string, data?: Record<string, unknown>) {
    const row: ActivityRow = { id: 0, ts: Date.now(), level, kind, message, data: data ? JSON.stringify(data) : null };
    row.id = this.db.insertActivity(row);
    this.activityBuffer.push(row);
    if (this.activityBuffer.length > 300) this.activityBuffer.splice(0, this.activityBuffer.length - 300);
    this.log[level]({ kind, ...data }, message);
    this.emit('activity', row);
  }

  recentActivity(n: number) {
    return this.activityBuffer.slice(-n).reverse();
  }

  // ---- counters -----------------------------------------------------------------------------

  bump(chain: string, key: keyof Omit<Totals, 'volumeSettled'>, by = 1) {
    this.totals[key] += by;
    const pc = this.perChain[chain];
    if (pc) pc[key] += by;
    this.markDirty();
  }

  private flushScheduled = false;
  /** Counters are flushed right after the change that moved them, so even a hard kill loses nothing. */
  markDirty() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.persistCounters();
    });
  }

  persistCounters() {
    this.db.setKv('totals', this.totals);
    this.db.setKv('per_chain', this.perChain);
    this.db.setKv(
      'mover_stats',
      Object.fromEntries(this.movers.map((mv) => [mv.index, mv.stats])),
    );
  }

  recordGumRequest(op: string, status: number, ms: number) {
    this.gumStats.requests++;
    const key = status === 0 ? 'network' : String(status);
    this.gumStats.byStatus[key] = (this.gumStats.byStatus[key] ?? 0) + 1;
    const samples = (this.gumStats.latency[op] ??= []);
    samples.push(ms);
    if (samples.length > 500) samples.splice(0, samples.length - 500);
    m.gumRequests.inc({ op, status: key });
    m.gumLatency.observe({ op }, ms / 1000);
  }

  // ---- deposits -----------------------------------------------------------------------------

  /**
   * Applies Gum's view of a deposit. Idempotent: replays and out-of-order observations are ignored
   * because only forward transitions change anything.
   */
  applyGumDeposit(d: GumDeposit, source: 'poll' | 'webhook' | 'fetch') {
    const row = this.open.get(d.id) ?? (source === 'fetch' ? this.db.getDeposit(d.id) : undefined);
    if (!row) return;
    const patch: Partial<DepositRow> = {};
    const ts = (s?: string | null) => (s ? Date.parse(s) : null);

    if (row.gum_created_at == null) patch.gum_created_at = ts(d.timestamps.created_at);
    const detected = ts(d.timestamps.detected_at);
    if (detected && row.detected_at == null) {
      patch.detected_at = detected;
      this.bump(row.chain, 'detected');
      if (row.pay_mined_at) m.detectLatency.observe({ chain: row.chain }, Math.max(detected - row.pay_mined_at, 0) / 1000);
    }
    if ((d.status === 'paid' || d.status === 'settled') && row.ready_at == null) {
      patch.ready_at = readyTime(d) ?? Date.now();
    }
    if (d.tx_hash && row.settle_tx !== d.tx_hash) patch.settle_tx = d.tx_hash;
    if (d.failure) {
      patch.failure_code = d.failure.code;
      patch.failure_message = d.failure.message;
    }
    if (d.events?.length) {
      const stages: Record<string, number> = {};
      for (const e of d.events) if (!(e.type in stages)) stages[e.type] = Date.parse(e.created_at);
      patch.stages = JSON.stringify(stages);
      const ready = stages['deposit.ready'];
      if (ready) patch.ready_at = ready;
    }

    const prev = row.status as DepositStatus;
    const statusChanged = d.status !== prev && !TERMINAL.has(prev);
    if (statusChanged) {
      patch.status = d.status;
      m.depositTransitions.inc({ chain: row.chain, status: d.status });
      if (TERMINAL.has(d.status)) {
        const at =
          ts(d.timestamps.settled_at) ?? ts(d.timestamps.failed_at) ?? ts(d.timestamps.expired_at) ?? Date.now();
        patch.terminal = 1;
        patch.terminal_at = at;
        if (d.status === 'settled') patch.settled_at = ts(d.timestamps.settled_at) ?? at;
      }
    }

    if (Object.keys(patch).length === 0) return;
    Object.assign(row, patch);
    this.db.updateDeposit(row.id, patch);
    if (statusChanged && TERMINAL.has(d.status)) this.finishDeposit(row);
    this.emit('deposit', row);
  }

  private finishDeposit(row: DepositRow) {
    this.open.delete(row.id);
    const mover = this.movers[row.mover];
    const status = row.status as DepositStatus;
    const paid = row.pay_status === 'mined';
    m.depositOutcomes.inc({ chain: row.chain, status });
    if (status === 'settled') {
      this.bump(row.chain, 'settled');
      this.totals.volumeSettled = (BigInt(this.totals.volumeSettled) + BigInt(row.amount)).toString();
      const pc = this.perChain[row.chain];
      if (pc) pc.volumeSettled = (BigInt(pc.volumeSettled) + BigInt(row.amount)).toString();
      if (row.pay_mined_at && row.settled_at) m.settleLatency.observe({ chain: row.chain }, Math.max(row.settled_at - row.pay_mined_at, 0) / 1000);
      if (row.settled_at) m.e2eLatency.observe({ chain: row.chain }, Math.max(row.settled_at - row.created_at, 0) / 1000);
    } else if (status === 'failed') {
      this.bump(row.chain, 'failed');
      this.activity('error', 'deposit.failed', `deposit ${short(row.id)} on ${row.chain} failed: ${row.failure_code ?? 'unknown'}`, {
        deposit: row.id,
        mover: row.mover,
        code: row.failure_code,
        message: row.failure_message,
      });
    } else if (status === 'expired') {
      this.bump(row.chain, 'expired');
      if (!paid) this.bump(row.chain, 'expiredUnpaid');
      this.activity(paid ? 'error' : 'warn', 'deposit.expired', `deposit ${short(row.id)} on ${row.chain} expired${paid ? ' after it was paid' : ' (never paid)'}`, {
        deposit: row.id,
        mover: row.mover,
      });
    }
    if (mover) {
      // Settlement paid the mover back. Credit the cached balance now so it does not read as
      // "no USDC" until the next balance read confirms it.
      const bal = mover.balances[row.chain as ChainSlug];
      if (status === 'settled' && bal?.token !== undefined && bal.at < (row.settled_at ?? Date.now())) {
        bal.token += BigInt(row.amount);
      }
      if (status === 'settled') mover.stats.settled++;
      else if (status === 'failed') mover.stats.failed++;
      else mover.stats.expired++;
      mover.lastDeposit = { id: row.id, status, at: Date.now() };
      if (mover.activeDeposit === row.id) {
        mover.activeDeposit = undefined;
        mover.phase = 'idle';
      }
    }
    this.onDepositTerminal(row);
  }

  // ---- movers -------------------------------------------------------------------------------

  /** Picks the chain a mover can pay on: its preferred chain if funded there, else any funded chain. */
  resolveMoverChain(mv: MoverState): ChainSlug | undefined {
    const amount = this.config.deposit.amount;
    const funded = (slug: ChainSlug) => {
      const b = mv.balances[slug];
      return b?.token !== undefined && b.token >= amount && (b.native ?? 0n) > 0n;
    };
    if (funded(mv.preferredChain)) return mv.preferredChain;
    for (const slug of this.chains.keys()) if (funded(slug)) return slug;
    return undefined;
  }

  moverHealth(mv: MoverState): MoverHealth {
    if (!mv.enabled) return 'disabled';
    const b = mv.balances[mv.chain];
    if (!b || b.native === undefined || b.token === undefined) return 'unknown';
    const chain = this.chains.get(mv.chain);
    if (b.native === 0n) return 'no_gas';
    if (!mv.activeDeposit && b.token < this.config.deposit.amount) return 'no_token';
    if (mv.lastError && Date.now() - mv.lastError.at < 120_000) return 'error';
    if (chain && b.native < chain.gasMin) return 'low_gas';
    return 'ok';
  }

  moverError(mv: MoverState, message: string) {
    mv.lastError = { message, at: Date.now() };
    mv.stats.errors++;
    this.markDirty();
  }

  setMoverEnabled(index: number, enabled: boolean) {
    const mv = this.movers[index];
    if (!mv) return false;
    mv.enabled = enabled;
    this.db.setKv(
      'disabled_movers',
      this.movers.filter((x) => !x.enabled).map((x) => x.index),
    );
    this.activity('info', 'control', `mover #${index} ${enabled ? 'enabled' : 'disabled'}`);
    return true;
  }
}

export const short = (s: string) => (s.length > 12 ? `${s.slice(0, 8)}…` : s);
export const fmt = (v: bigint | undefined, decimals: number) => (v === undefined ? null : formatUnits(v, decimals));

function readyTime(d: GumDeposit): number | undefined {
  const e = d.events?.find((x) => x.type === 'deposit.ready');
  return e ? Date.parse(e.created_at) : undefined;
}
