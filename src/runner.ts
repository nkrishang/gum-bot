import { encodeFunctionData, erc20Abi, getAddress, keccak256, parseAbi, type PublicClient } from 'viem';
import type { Bot, MoverState } from './bot.ts';
import type { ChainSlug } from './config.ts';
import type { DepositRow } from './db.ts';
import { GumError, sleep, type GumDeposit } from './gum.ts';
import { m } from './metrics.ts';
import { RateCap } from './ratecap.ts';
import type { Tracker } from './tracker.ts';
import { errMessage, type Treasury } from './treasury.ts';

const factoryAbi = parseAbi([
  'function paymentAddress(address token, uint256 amount, address receiver, uint64 expirationTimestamp, address recovery, bytes32 salt, uint256 chainId) view returns (address)',
]);

export type CyclePhase = 'dispatching' | 'settling' | 'cooldown';

export interface CycleState {
  id: number;
  startedAt: number;
  endedAt?: number;
  phase: CyclePhase;
  planned: number;
  created: number;
  paid: number;
  settled: number;
  failed: number;
  carried: number;
  errors: number;
  deposits: Set<string>;
  /** Movers skipped this cycle and why (no USDC, busy with a carried deposit, …). */
  skipped: Record<string, number>;
  nextAt?: number;
}

/**
 * The cycle: every mover that is free and funded gets a fresh deposit (receiver = itself) on the
 * chain it pays on, immediately pays it 1 USDC, and the cycle then waits for Gum to settle them all.
 * Settlement returns the USDC to the mover, which makes it ready for the next cycle. Deposits that
 * outlive the settle timeout are carried over: tracking continues, and their movers sit out until
 * they resolve.
 */
export class Runner {
  paused: boolean;
  current?: CycleState;
  last?: CycleState;
  /** Set while no mover can take a deposit, with the reasons. */
  waiting?: { since: number; skipped: Record<string, number>; until?: number };
  /** At most `deposit.maxPerMinute` creations in any rolling minute. */
  readonly rateCap: RateCap;
  private rotation = 0;
  private stopping = false;
  private loopDone?: Promise<void>;
  private wake?: () => void;
  private cycleSeq: number;

  constructor(
    private readonly bot: Bot,
    private readonly treasury: Treasury,
    private readonly tracker: Tracker,
  ) {
    const persisted = bot.db.getKv<boolean>('paused');
    this.paused = persisted ?? bot.config.startPaused;
    m.paused.set(this.paused ? 1 : 0);
    this.cycleSeq = bot.db.lastCycleId();
    // Seeded from the database so a restart cannot exceed the cap within the minute.
    this.rateCap = new RateCap(bot.config.deposit.maxPerMinute, 60_000, bot.db.createdSince(Date.now() - 60_000));
    m.rateCapLimit.set(bot.config.deposit.maxPerMinute);
  }

  start() {
    this.loopDone = this.loop();
  }

  async stop() {
    this.stopping = true;
    this.wake?.();
    await this.loopDone;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.bot.db.setKv('paused', paused);
    m.paused.set(paused ? 1 : 0);
    this.bot.activity('info', 'control', paused ? 'runner paused' : 'runner resumed');
    this.wake?.();
  }

  private async loop() {
    while (!this.stopping) {
      if (this.paused) {
        await this.idle(1_000);
        continue;
      }
      const started = Date.now();
      let ran = false;
      try {
        ran = await this.runCycle();
      } catch (err) {
        this.bot.activity('error', 'cycle.error', `cycle crashed: ${errMessage(err)}`);
        await this.idle(5_000);
      }
      const wait = this.bot.config.cycle.minIntervalMs - (Date.now() - started);
      if (ran && wait > 0 && !this.stopping) {
        if (this.current) {
          this.current.phase = 'cooldown';
          this.current.nextAt = Date.now() + wait;
        }
        await this.idle(wait);
      }
      if (this.current) {
        this.last = this.current;
        this.current = undefined;
      }
    }
  }

  private idle(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    }).finally(() => (this.wake = undefined));
  }

  /** Movers that can take a deposit now, and a tally of why the others cannot. */
  private selectMovers() {
    const ready: Array<{ mv: MoverState; chain: ChainSlug }> = [];
    const skipped: Record<string, number> = {};
    const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
    for (const mv of this.bot.movers) {
      if (!mv.enabled) skip('disabled');
      else if (mv.activeDeposit) skip('carried_over');
      else {
        const chain = this.bot.resolveMoverChain(mv);
        if (chain) ready.push({ mv, chain });
        else {
          const b = mv.balances[mv.chain];
          skip(!b ? 'balance_unknown' : (b.native ?? 0n) === 0n ? 'no_gas' : 'no_token');
        }
      }
    }
    return { ready, skipped };
  }

  private async runCycle() {
    const bot = this.bot;
    const selection = this.selectMovers();
    const { skipped } = selection;
    let { ready } = selection;
    if (ready.length === 0) {
      // Not a cycle: nothing to do until a top-up lands or a carried deposit resolves.
      this.waiting = { since: this.waiting?.since ?? Date.now(), skipped };
      await this.idle(2_000);
      return false;
    }
    // The rate cap bounds how many deposits this cycle may create. Movers take turns, so a binding
    // cap spreads deposits across all of them rather than always favouring the first few.
    const allowance = this.rateCap.available();
    m.rateCapUsed.set(this.rateCap.used());
    if (allowance === 0) {
      const until = this.rateCap.nextFreeAt();
      this.waiting = { since: this.waiting?.since ?? Date.now(), skipped: { ...skipped, rate_cap: ready.length }, until };
      await this.idle(Math.min(Math.max(until - Date.now(), 250), 5_000));
      return false;
    }
    if (ready.length > allowance) {
      const start = this.rotation % ready.length;
      ready = [...ready.slice(start), ...ready.slice(0, start)];
      skipped.rate_cap = ready.length - allowance;
      ready = ready.slice(0, allowance);
      this.rotation += allowance;
    }
    this.waiting = undefined;
    const cycle: CycleState = {
      id: ++this.cycleSeq,
      startedAt: Date.now(),
      phase: 'dispatching',
      planned: ready.length,
      created: 0,
      paid: 0,
      settled: 0,
      failed: 0,
      carried: 0,
      errors: 0,
      deposits: new Set(),
      skipped,
    };
    this.current = cycle;
    for (const { mv, chain } of ready) mv.chain = chain;
    this.persist(cycle);

    await Promise.all(ready.map(({ mv, chain }) => this.createAndPay(cycle, mv, chain)));
    this.tracker.poke();

    cycle.phase = 'settling';
    const deadline = Date.now() + bot.config.cycle.settleTimeoutMs;
    while (!this.stopping && Date.now() < deadline) {
      if (this.pendingIn(cycle) === 0) break;
      await sleep(250);
      this.tally(cycle);
    }
    this.tally(cycle);
    cycle.carried = this.pendingIn(cycle);
    // Settlement returned the USDC; re-read balances so these movers qualify for the next cycle.
    await Promise.all(ready.map(({ mv }) => this.treasury.refreshMover(mv, mv.chain)));
    cycle.endedAt = Date.now();
    this.persist(cycle);
    bot.bump('_', 'cycles');
    m.cycles.inc();
    m.cycleSeconds.observe((cycle.endedAt - cycle.startedAt) / 1000);
    bot.persistCounters();
    bot.activity(
      cycle.failed || cycle.errors || cycle.carried ? 'warn' : 'info',
      'cycle',
      `cycle #${cycle.id}: ${cycle.settled}/${cycle.planned} settled in ${((cycle.endedAt - cycle.startedAt) / 1000).toFixed(1)}s` +
        (cycle.failed ? `, ${cycle.failed} failed` : '') +
        (cycle.errors ? `, ${cycle.errors} errors` : '') +
        (cycle.carried ? `, ${cycle.carried} carried over` : ''),
      { cycle: cycle.id, planned: cycle.planned, settled: cycle.settled, failed: cycle.failed, errors: cycle.errors, carried: cycle.carried },
    );
    return true;
  }

  /** Deposits of this cycle that are paid but not yet terminal. */
  private pendingIn(cycle: CycleState) {
    let n = 0;
    for (const id of cycle.deposits) {
      const row = this.bot.open.get(id);
      if (row && row.pay_status === 'mined') n++;
    }
    return n;
  }

  private tally(cycle: CycleState) {
    let settled = 0;
    let failed = 0;
    for (const id of cycle.deposits) {
      if (this.bot.open.has(id)) continue;
      const row = this.bot.db.getDeposit(id);
      if (row?.status === 'settled') settled++;
      else if (row && row.pay_status === 'mined') failed++;
    }
    cycle.settled = settled;
    cycle.failed = failed;
  }

  private persist(c: CycleState) {
    this.bot.db.upsertCycle({
      id: c.id,
      started_at: c.startedAt,
      ended_at: c.endedAt ?? null,
      planned: c.planned,
      created: c.created,
      paid: c.paid,
      settled: c.settled,
      failed: c.failed,
      carried: c.carried,
      errors: c.errors,
    });
  }

  private async createAndPay(cycle: CycleState, mv: MoverState, slug: ChainSlug) {
    const bot = this.bot;
    const chain = bot.chain(slug);
    const amount = bot.config.deposit.amount;
    mv.phase = 'creating';

    // 1. Create the deposit. The idempotency key makes client retries safe. Every attempt counts
    // against the rate cap, whether or not it succeeds.
    const slot = this.rateCap.record();
    m.rateCapUsed.set(this.rateCap.used());
    const expiresAt = new Date(Date.now() + bot.config.deposit.expirySecs * 1000);
    expiresAt.setMilliseconds(0);
    let deposit: GumDeposit;
    const t0 = performance.now();
    try {
      const res = await bot.gum.createDeposit(
        {
          chain_id: slug,
          token: 'USDC',
          amount: amount.toString(),
          receiver: mv.address,
          expires_at: expiresAt.toISOString(),
          ...(bot.config.gum.webhookSecret && bot.config.publicUrl ? { webhook_url: `${bot.config.publicUrl}/webhooks/gum` } : {}),
        },
        `gumbot-${bot.bootId}-${cycle.id}-${mv.index}`,
      );
      deposit = res.deposit;
      slot.complete();
    } catch (err) {
      slot.complete();
      const code = err instanceof GumError ? err.code : 'error';
      cycle.errors++;
      bot.bump(slug, 'createErrors');
      m.depositCreateErrors.inc({ chain: slug, code });
      bot.moverError(mv, `create: ${errMessage(err)}`);
      bot.activity('error', 'create.failed', `could not create a deposit for mover #${mv.index} on ${slug}: ${errMessage(err)}`, {
        mover: mv.index,
        code,
        requestId: err instanceof GumError ? err.requestId : undefined,
      });
      mv.phase = 'idle';
      return;
    }
    const createMs = Math.round(performance.now() - t0);
    const now = Date.now();
    const row: DepositRow = {
      id: deposit.id,
      cycle: cycle.id,
      mover: mv.index,
      mover_address: mv.address,
      chain: slug,
      payment_address: deposit.payment_address,
      token_address: deposit.token_address,
      amount: deposit.amount,
      status: deposit.status,
      pay_status: 'pending',
      pay_tx: null,
      pay_error: null,
      pay_gas_cost: null,
      create_ms: createMs,
      created_at: now,
      gum_created_at: Date.parse(deposit.timestamps.created_at),
      expires_at: Date.parse(deposit.expires_at),
      pay_sent_at: null,
      pay_mined_at: null,
      detected_at: null,
      ready_at: null,
      settled_at: null,
      terminal_at: null,
      settle_tx: null,
      failure_code: null,
      failure_message: null,
      stages: null,
      webhooks: null,
      updated_at: now,
      terminal: 0,
    };
    bot.db.insertDeposit(row);
    bot.open.set(row.id, row);
    cycle.deposits.add(row.id);
    cycle.created++;
    bot.bump(slug, 'created');
    mv.stats.created++;
    mv.activeDeposit = row.id;
    m.depositsCreated.inc({ chain: slug });
    bot.emit('deposit', row);

    // 2. Never send funds to an address we cannot vouch for.
    const problem = await this.verify(deposit, mv, slug).catch((err) => `verification error: ${errMessage(err)}`);
    if (problem) {
      cycle.errors++;
      bot.bump(slug, 'addressMismatch');
      m.addressMismatch.inc({ chain: slug });
      this.markUnpaid(row, mv, 'skipped', problem);
      bot.activity('error', 'verify.failed', `refused to pay deposit ${deposit.id} for mover #${mv.index}: ${problem}`, {
        deposit: deposit.id,
        mover: mv.index,
      });
      return;
    }

    // 3. Pay it. The transfer is signed locally and its hash recorded before it is broadcast, so a
    // flaky RPC can never leave us unsure whether funds moved: retries resend the same signed bytes
    // (same nonce), which can land at most once, and the receipt is looked up by the known hash.
    mv.phase = 'paying';
    const wallet = chain.wallet(mv.account);
    let raw: `0x${string}`;
    try {
      const request = await withRetries(
        () =>
          wallet.prepareTransactionRequest({
            account: mv.account,
            chain: chain.public.chain,
            to: deposit.token_address,
            data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [deposit.payment_address, amount] }),
          }),
        3,
      );
      raw = await wallet.signTransaction(request as Parameters<typeof wallet.signTransaction>[0]);
    } catch (err) {
      // Nothing was signed or sent: the mover still holds its USDC.
      cycle.errors++;
      bot.bump(slug, 'payErrors');
      m.payments.inc({ chain: slug, outcome: 'prepare_error' });
      this.markUnpaid(row, mv, 'failed', `prepare: ${errMessage(err)}`);
      bot.moverError(mv, `pay: ${errMessage(err)}`);
      bot.activity('error', 'pay.failed', `mover #${mv.index} could not prepare its payment on ${slug}: ${errMessage(err)}`, { mover: mv.index, deposit: row.id });
      void this.treasury.refreshMover(mv, slug);
      return;
    }
    const hash = keccak256(raw);
    this.update(row, { pay_status: 'sent', pay_tx: hash, pay_sent_at: Date.now() });
    const accepted = await this.broadcast(chain.public, raw, hash);
    if (!accepted.ok) {
      // Every send failed and the node does not know the transaction. It may still surface later;
      // the deposit stays tracked by hash, and if it lands Gum settles it like any other.
      cycle.errors++;
      bot.bump(slug, 'payErrors');
      m.payments.inc({ chain: slug, outcome: 'send_error' });
      this.markUnpaid(row, mv, 'failed', `broadcast: ${accepted.error}`);
      bot.moverError(mv, `pay: ${accepted.error}`);
      bot.activity('error', 'pay.failed', `mover #${mv.index} could not broadcast its payment on ${slug}: ${accepted.error}`, { mover: mv.index, deposit: row.id, tx: hash });
      void this.treasury.refreshMover(mv, slug);
      return;
    }
    const sentAt = row.pay_sent_at!;

    try {
      const receipt = await chain.public.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 1_000 });
      if (receipt.status !== 'success') throw new Error(`transfer ${hash} reverted`);
      const minedAt = Date.now();
      this.update(row, {
        pay_status: 'mined',
        pay_mined_at: minedAt,
        pay_gas_cost: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      });
      cycle.paid++;
      bot.bump(slug, 'paid');
      mv.stats.paid++;
      mv.phase = mv.activeDeposit === row.id ? 'settling' : mv.phase;
      m.payments.inc({ chain: slug, outcome: 'success' });
      m.payLatency.observe({ chain: slug }, (minedAt - sentAt) / 1000);
      void this.treasury.refreshMover(mv, slug);
    } catch (err) {
      // Broadcast but unconfirmed or reverted. The mover's balance tells whether the funds moved;
      // Gum's view of the deposit tells whether the payment landed.
      cycle.errors++;
      bot.bump(slug, 'payErrors');
      m.payments.inc({ chain: slug, outcome: 'receipt_error' });
      bot.moverError(mv, `pay receipt: ${errMessage(err)}`);
      const reverted = errMessage(err).includes('reverted');
      if (reverted) this.markUnpaid(row, mv, 'failed', errMessage(err));
      else {
        // Keep the mover tied to the deposit: if the transfer did land, Gum settles it back.
        this.update(row, { pay_status: 'mined', pay_error: `receipt: ${errMessage(err)}` });
      }
      bot.activity('error', 'pay.receipt', `mover #${mv.index} payment ${hash} on ${slug}: ${errMessage(err)}`, { mover: mv.index, deposit: row.id });
    }
  }

  private async verify(d: GumDeposit, mv: MoverState, slug: ChainSlug): Promise<string | undefined> {
    const chain = this.bot.chain(slug);
    const amount = this.bot.config.deposit.amount;
    if (getAddress(d.receiver) !== mv.address) return `receiver ${d.receiver} is not the mover`;
    if (d.amount !== amount.toString()) return `amount ${d.amount} != ${amount}`;
    if (d.chain_id !== chain.chainId) return `chain_id ${d.chain_id} != ${chain.chainId}`;
    if (getAddress(d.token_address) !== getAddress(chain.token.address)) return `token ${d.token_address} is not ${chain.token.address}`;
    if (this.bot.factory && this.bot.verifyChains.has(slug)) {
      // The address must be what the on-chain factory derives from the deposit's terms; a mismatch
      // would be a Gum bug that strands funds.
      const expected = await chain.public.readContract({
        address: this.bot.factory,
        abi: factoryAbi,
        functionName: 'paymentAddress',
        args: [
          getAddress(d.token_address),
          BigInt(d.amount),
          getAddress(d.receiver),
          BigInt(Math.floor(Date.parse(d.expires_at) / 1000)),
          getAddress(d.recovery),
          d.salt,
          BigInt(d.chain_id),
        ],
      });
      if (getAddress(expected) !== getAddress(d.payment_address)) {
        return `payment_address ${d.payment_address} != factory.paymentAddress ${expected}`;
      }
    }
    return undefined;
  }

  /**
   * Sends signed bytes, retrying transient failures. "Already known" or "nonce too low" mean the node
   * has it (or it was mined), so they count as accepted; when every attempt errors, the node is asked
   * directly whether it has the transaction before giving up.
   */
  private async broadcast(pub: PublicClient, raw: `0x${string}`, hash: `0x${string}`): Promise<{ ok: true } | { ok: false; error: string }> {
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await pub.sendRawTransaction({ serializedTransaction: raw });
        return { ok: true };
      } catch (err) {
        last = errMessage(err);
        const text = `${last} ${(err as { details?: string }).details ?? ''}`.toLowerCase();
        if (/already known|known transaction|nonce too low|already imported|higher priority/.test(text)) return { ok: true };
        if (/insufficient funds|insufficient balance|reverted|invalid sender/.test(text)) break;
        await sleep(500 * 2 ** attempt);
      }
    }
    const known = await pub.getTransaction({ hash }).then(() => true, () => false);
    const mined = known || (await pub.getTransactionReceipt({ hash }).then(() => true, () => false));
    return mined ? { ok: true } : { ok: false, error: last };
  }

  private markUnpaid(row: DepositRow, mv: MoverState, status: 'failed' | 'skipped', error: string) {
    this.update(row, { pay_status: status, pay_error: error });
    if (mv.activeDeposit === row.id) mv.activeDeposit = undefined;
    mv.phase = 'idle';
  }

  private update(row: DepositRow, patch: Partial<DepositRow>) {
    Object.assign(row, patch);
    this.bot.db.updateDeposit(row.id, patch);
    this.bot.emit('deposit', row);
  }
}

/** Retries an operation that has no side effects (reads, gas and fee estimation). */
async function withRetries<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i + 1 >= attempts) throw err;
      await sleep(400 * 2 ** i);
    }
  }
}
