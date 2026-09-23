import { erc20Abi, formatUnits } from 'viem';
import type { Bot, MoverState } from './bot.ts';
import type { ChainSlug } from './config.ts';
import { m } from './metrics.ts';

/**
 * Keeps balances fresh and movers fuelled. A periodic sweep reads every wallet's native and USDC
 * balance on every enabled chain (one batched JSON-RPC request per chain), then queues a gas top-up
 * from the funder for any mover whose native balance on the chain it pays on is below the threshold.
 * Top-ups are sent one at a time per chain so the funder's nonces never race.
 */
export class Treasury {
  private queues = new Map<ChainSlug, MoverState[]>();
  private inFlight = new Set<string>();
  private workers = new Map<ChainSlug, Promise<void>>();
  private lastFunderAlert = new Map<ChainSlug, number>();
  /** After a failed top-up, the same mover is not retried for a minute. */
  private cooldownUntil = new Map<string, number>();
  private stopping = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly bot: Bot) {}

  start() {
    const tick = async () => {
      await this.refreshAll().catch((err) => this.bot.log.error({ err }, 'balance sweep failed'));
      if (!this.stopping) this.timer = setTimeout(tick, this.bot.config.balanceRefreshMs);
    };
    return tick();
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.timer);
  }

  async refreshAll() {
    await Promise.all([...this.bot.chains.keys()].map((slug) => this.refreshChain(slug)));
    for (const mv of this.bot.movers) {
      if (!mv.activeDeposit && mv.phase === 'idle') mv.chain = this.bot.resolveMoverChain(mv) ?? mv.preferredChain;
    }
    this.updateHealthGauges();
    for (const slug of this.bot.chains.keys()) this.checkTopups(slug);
  }

  private async refreshChain(slug: ChainSlug) {
    const bot = this.bot;
    const chain = bot.chain(slug);
    const health = bot.chainHealth.get(slug)!;
    const t0 = performance.now();
    try {
      const block = await chain.public.getBlockNumber({ cacheTime: 0 });
      health.rpcLatencyMs = Math.round(performance.now() - t0);
      health.block = Number(block);
      m.rpcLatency.set({ chain: slug }, health.rpcLatencyMs / 1000);

      const addrs = [bot.funder.address, ...bot.movers.map((mv) => mv.address)];
      const [natives, tokens] = await Promise.all([
        Promise.all(addrs.map((address) => chain.public.getBalance({ address }))),
        Promise.all(
          addrs.map((address) =>
            chain.public.readContract({ address: chain.token.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
          ),
        ),
      ]);
      const now = Date.now();
      health.funder = { native: natives[0], token: tokens[0], at: now };
      m.funderNative.set({ chain: slug }, Number(formatUnits(natives[0]!, 18)));
      bot.movers.forEach((mv, i) => {
        mv.balances[slug] = { native: natives[i + 1], token: tokens[i + 1], at: now };
        m.moverNative.set({ mover: String(mv.index), chain: slug }, Number(formatUnits(natives[i + 1]!, 18)));
        m.moverToken.set({ mover: String(mv.index), chain: slug }, Number(formatUnits(tokens[i + 1]!, chain.token.decimals)));
      });
      health.rpcOk = true;
      health.updatedAt = now;

      if (natives[0]! < chain.funderMin) {
        const last = this.lastFunderAlert.get(slug) ?? 0;
        if (now - last > 15 * 60_000) {
          this.lastFunderAlert.set(slug, now);
          bot.activity('warn', 'funder.low', `funder is low on ${slug}: ${formatUnits(natives[0]!, 18)} ${chain.nativeSymbol} (alert below ${chain.config.funderMin})`);
        }
      }
    } catch (err) {
      health.rpcOk = false;
      health.lastError = { message: errMessage(err), at: Date.now() };
      m.rpcErrors.inc({ chain: slug, op: 'balances' });
      bot.log.warn({ chain: slug, err: errMessage(err) }, 'balance refresh failed');
    }
  }

  /** Re-reads one mover's balances on one chain, e.g. right after it paid or got paid back. */
  async refreshMover(mv: MoverState, slug: ChainSlug) {
    const chain = this.bot.chain(slug);
    try {
      const [native, token] = await Promise.all([
        chain.public.getBalance({ address: mv.address }),
        chain.public.readContract({ address: chain.token.address, abi: erc20Abi, functionName: 'balanceOf', args: [mv.address] }),
      ]);
      mv.balances[slug] = { native, token, at: Date.now() };
      m.moverNative.set({ mover: String(mv.index), chain: slug }, Number(formatUnits(native, 18)));
      m.moverToken.set({ mover: String(mv.index), chain: slug }, Number(formatUnits(token, chain.token.decimals)));
      this.checkTopups(slug);
    } catch (err) {
      m.rpcErrors.inc({ chain: slug, op: 'mover_balance' });
    }
  }

  updateHealthGauges() {
    const counts: Record<string, number> = { ok: 0, low_gas: 0, no_gas: 0, no_token: 0, error: 0, disabled: 0, unknown: 0 };
    for (const mv of this.bot.movers) counts[this.bot.moverHealth(mv)]!++;
    for (const [health, n] of Object.entries(counts)) m.moversReady.set({ health }, n);
  }

  checkTopups(slug: ChainSlug) {
    const chain = this.bot.chain(slug);
    for (const mv of this.bot.movers) {
      if (mv.chain !== slug || !mv.enabled) continue;
      const native = mv.balances[slug]?.native;
      if (native === undefined || native >= chain.gasMin) continue;
      this.requestTopup(mv, slug);
    }
  }

  /** Queues a top-up unless one is already queued or in flight. Returns false if already pending. */
  requestTopup(mv: MoverState, slug: ChainSlug): boolean {
    const key = `${slug}:${mv.index}`;
    if (this.inFlight.has(key) || (this.cooldownUntil.get(key) ?? 0) > Date.now()) return false;
    this.inFlight.add(key);
    const q = this.queues.get(slug) ?? [];
    q.push(mv);
    this.queues.set(slug, q);
    if (!this.workers.has(slug)) {
      this.workers.set(
        slug,
        this.drain(slug).finally(() => this.workers.delete(slug)),
      );
    }
    return true;
  }

  pendingTopups() {
    return [...this.inFlight];
  }

  private async drain(slug: ChainSlug) {
    const q = this.queues.get(slug)!;
    while (q.length && !this.stopping) {
      const mv = q.shift()!;
      try {
        await this.topup(mv, slug);
      } finally {
        this.inFlight.delete(`${slug}:${mv.index}`);
      }
    }
  }

  private async topup(mv: MoverState, slug: ChainSlug) {
    const bot = this.bot;
    const chain = bot.chain(slug);
    const funderNative = bot.chainHealth.get(slug)?.funder.native;
    if (funderNative !== undefined && funderNative < chain.gasTopup) {
      bot.bump(slug, 'topupErrors');
      m.topups.inc({ chain: slug, outcome: 'insufficient' });
      this.cooldownUntil.set(`${slug}:${mv.index}`, Date.now() + 60_000);
      bot.activity('error', 'topup.insufficient', `cannot top up mover #${mv.index} on ${slug}: funder has ${formatUnits(funderNative, 18)} ${chain.nativeSymbol}`);
      return;
    }
    const amount = chain.gasTopup;
    const created = Date.now();
    const id = bot.db.insertTopup({
      chain: slug,
      mover: mv.index,
      address: mv.address,
      amount: amount.toString(),
      tx: null,
      status: 'sent',
      error: null,
      created_at: created,
      mined_at: null,
    });
    try {
      const hash = await chain.wallet(bot.funder).sendTransaction({
        account: bot.funder,
        chain: chain.public.chain,
        to: mv.address,
        value: amount,
      });
      bot.db.updateTopup(id, { tx: hash });
      const receipt = await chain.public.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== 'success') throw new Error(`top-up ${hash} reverted`);
      bot.db.updateTopup(id, { status: 'mined', mined_at: Date.now() });
      bot.bump(slug, 'topups');
      mv.stats.topups++;
      m.topups.inc({ chain: slug, outcome: 'success' });
      bot.activity('info', 'topup', `topped up mover #${mv.index} with ${formatUnits(amount, 18)} ${chain.nativeSymbol} on ${slug}`, {
        mover: mv.index,
        tx: hash,
      });
      await this.refreshMover(mv, slug);
    } catch (err) {
      this.cooldownUntil.set(`${slug}:${mv.index}`, Date.now() + 60_000);
      bot.db.updateTopup(id, { status: 'failed', error: errMessage(err) });
      bot.bump(slug, 'topupErrors');
      m.topups.inc({ chain: slug, outcome: 'error' });
      bot.activity('error', 'topup.failed', `top-up of mover #${mv.index} on ${slug} failed: ${errMessage(err)}`, { mover: mv.index });
    }
  }
}

export function errMessage(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  let msg = (e?.shortMessage ?? e?.message ?? String(err)).split('\n')[0]!;
  // viem wraps transport errors; surface the HTTP status and provider message so a 429 is
  // distinguishable from a timeout or an outage.
  for (let c: any = err, depth = 0; c && depth < 5; c = c.cause, depth++) {
    if (typeof c.status === 'number' && !msg.includes(`HTTP ${c.status}`)) msg += ` (HTTP ${c.status})`;
    if (typeof c.details === 'string' && c.details && !msg.includes(c.details.slice(0, 40))) {
      msg += `: ${c.details.split('\n')[0]!.slice(0, 160)}`;
      break;
    }
  }
  return msg.slice(0, 300);
}
