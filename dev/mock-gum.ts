import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  erc20Abi,
  getAddress,
  isAddress,
  parseAbi,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { TokenBucket } from '../src/ratelimit.ts';

/**
 * A local stand-in for gum-server + gum-indexer + gum-engine, faithful where it matters to the bot:
 * the same request validation, response shapes, statuses, idempotency, per-key rate limit (50/s,
 * burst 100), event timeline and signed webhooks. Payment addresses come from the real
 * PaymentFactory on Anvil and settlement calls the real `execute`, so USDC genuinely travels
 * mover → payment address → mover.
 *
 * Chaos knobs: `failRate` fails that fraction of settlements (funds stay at the payment address),
 * `latencyMs` delays every API response, `rateLimit` tunes the bucket.
 */

const factoryAbi = parseAbi([
  'function paymentAddress(address token, uint256 amount, address receiver, uint64 expirationTimestamp, address recovery, bytes32 salt, uint256 chainId) view returns (address)',
  'function execute(address token, uint256 amount, address receiver, uint64 expirationTimestamp, address recovery, bytes32 salt, uint256 chainId)',
]);

export interface MockChain {
  slug: string;
  chain: Chain;
  public: PublicClient;
  settler: WalletClient;
  settlerAccount: Account;
  token: `0x${string}`;
  factory: `0x${string}`;
}

export interface MockGumOptions {
  port: number;
  apiKey: string;
  chains: MockChain[];
  recovery: `0x${string}`;
  webhookSecret: string;
  confirmations?: number;
  failRate?: number;
  latencyMs?: number;
  rateLimit?: { rps: number; burst: number };
  log?: (msg: string) => void;
}

type Status = 'pending' | 'partial_paid' | 'paid' | 'settled' | 'failed' | 'expired';

interface Deposit {
  id: string;
  status: Status;
  payment_address: `0x${string}`;
  chain_id: number;
  slug: string;
  token: string;
  token_address: `0x${string}`;
  token_decimals: number;
  amount: string;
  confirmed_amount: string;
  receiver: `0x${string}`;
  recovery: `0x${string}`;
  salt: `0x${string}`;
  webhook_url?: string;
  expires_at: string;
  tx_hash: string | null;
  block_number: number | null;
  failure: { code: string; message: string } | null;
  timestamps: {
    created_at: string;
    updated_at: string;
    detected_at: string | null;
    settled_at: string | null;
    failed_at: string | null;
    expired_at: string | null;
  };
  events: Array<{ id: string; sequence: number; type: string; data: unknown; created_at: string }>;
  /** Internal: block at which the payment was first seen, and whether settlement is running. */
  _seenBlock?: bigint;
  _settling?: boolean;
}

export function startMockGum(opts: MockGumOptions) {
  const log = opts.log ?? (() => {});
  const deposits = new Map<string, Deposit>();
  const order: Deposit[] = [];
  const idempotency = new Map<string, { hash: string; id: string }>();
  const bucket = new TokenBucket(opts.rateLimit?.rps ?? 50, opts.rateLimit?.burst ?? 100);
  const chainBySlug = new Map(opts.chains.map((c) => [c.slug, c]));
  const chainById = new Map(opts.chains.map((c) => [String(c.chain.id), c]));
  const confirmations = BigInt(opts.confirmations ?? 1);
  const stats = { created: 0, settled: 0, failed: 0, expired: 0, rateLimited: 0 };

  const now = () => new Date().toISOString();
  const err = (status: number, code: string, message: string) =>
    new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'content-type': 'application/json' } });
  const view = (d: Deposit, withEvents = false) => {
    const { events, _seenBlock, _settling, slug, ...rest } = d;
    return withEvents ? { ...rest, events } : rest;
  };

  function event(d: Deposit, type: string, data: unknown = {}) {
    const e = { id: randomUUID(), sequence: d.events.length + 1, type, data, created_at: now() };
    d.events.push(e);
    d.timestamps.updated_at = e.created_at;
    const appFacing = ['deposit.detected', 'deposit.payment_confirmed', 'deposit.ready', 'deposit.settled', 'deposit.failed', 'deposit.expired'];
    if (d.webhook_url && appFacing.includes(type)) void deliver(d, e);
  }

  async function deliver(d: Deposit, e: Deposit['events'][number]) {
    const body = JSON.stringify({ id: e.id, type: e.type, created_at: e.created_at, sequence: e.sequence, deposit: view(d), data: e.data });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', opts.webhookSecret).update(`${t}.${body}`).digest('hex');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(d.webhook_url!, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-gum-event-id': e.id,
            'x-gum-event-type': e.type,
            'x-gum-deposit-id': d.id,
            'x-gum-signature': `t=${t},v1=${sig}`,
          },
          body,
        });
        if (res.ok) return;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }

  const app = new Hono();
  app.use('*', async (c, next) => {
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    c.header('x-request-id', randomUUID());
    await next();
  });
  const authed = (c: { req: { header(name: string): string | undefined } }) => {
    const h = c.req.header('authorization') ?? '';
    const key = h.startsWith('Bearer ') ? h.slice(7) : c.req.header('x-api-key');
    if (key !== opts.apiKey) return err(401, 'unauthorized', 'invalid API key');
    if (!bucket.tryTake()) {
      stats.rateLimited++;
      return err(429, 'rate_limited', 'API key rate limit exceeded');
    }
    return undefined;
  };

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/v1/chains', (c) =>
    c.json({
      chains: opts.chains.map((ch) => ({
        name: ch.slug,
        chain_id: ch.chain.id,
        factory: ch.factory.toLowerCase(),
        tokens: [{ symbol: 'USDC', address: ch.token.toLowerCase(), decimals: 6 }],
      })),
    }),
  );
  app.get('/mock/stats', (c) => c.json({ ...stats, open: order.filter((d) => ['pending', 'partial_paid', 'paid'].includes(d.status)).length }));

  app.post('/v1/deposit', async (c) => {
    const denied = authed(c);
    if (denied) return denied;
    const raw = await c.req.text();
    let req: Record<string, unknown>;
    try {
      req = JSON.parse(raw);
    } catch {
      return err(400, 'invalid_request', 'body must be JSON');
    }
    const allowed = ['chain_id', 'token', 'amount', 'receiver', 'expires_at', 'reference', 'webhook_url'];
    const unknown = Object.keys(req).filter((k) => !allowed.includes(k));
    if (unknown.length) return err(400, 'invalid_request', `unknown field ${unknown[0]}`);

    const key = c.req.header('idempotency-key');
    if (key) {
      const prev = idempotency.get(key);
      if (prev) {
        if (prev.hash !== raw) return err(409, 'idempotency_conflict', 'idempotency key reused with a different request');
        c.header('idempotent-replayed', 'true');
        return c.json(view(deposits.get(prev.id)!), 200);
      }
    }

    const ch = chainBySlug.get(String(req.chain_id)) ?? chainById.get(String(req.chain_id));
    if (!ch) return err(400, 'unsupported_chain', `unsupported chain ${JSON.stringify(req.chain_id)}`);
    if (typeof req.token !== 'string' || (req.token.toUpperCase() !== 'USDC' && req.token.toLowerCase() !== ch.token.toLowerCase())) {
      return err(400, 'unsupported_token', `token ${JSON.stringify(req.token)} is not supported on ${ch.slug}`);
    }
    if (typeof req.amount !== 'string' || !/^[1-9]\d*$/.test(req.amount)) return err(400, 'invalid_request', 'amount must be a base-unit integer string');
    if (typeof req.receiver !== 'string' || !isAddress(req.receiver)) return err(400, 'invalid_request', 'receiver must be an address');
    const expires = Date.parse(String(req.expires_at));
    if (!Number.isFinite(expires)) return err(400, 'invalid_request', 'expires_at must be RFC 3339');
    if (expires - Date.now() < 300_000) return err(400, 'invalid_request', 'expires_at must be at least 300 seconds in the future');

    const salt = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
    const expSecs = BigInt(Math.floor(expires / 1000));
    const receiver = getAddress(req.receiver);
    const paymentAddress = await ch.public.readContract({
      address: ch.factory,
      abi: factoryAbi,
      functionName: 'paymentAddress',
      args: [ch.token, BigInt(req.amount), receiver, expSecs, opts.recovery, salt, BigInt(ch.chain.id)],
    });
    const ts = now();
    const d: Deposit = {
      id: randomUUID(),
      status: 'pending',
      payment_address: paymentAddress.toLowerCase() as `0x${string}`,
      chain_id: ch.chain.id,
      slug: ch.slug,
      token: 'USDC',
      token_address: ch.token.toLowerCase() as `0x${string}`,
      token_decimals: 6,
      amount: req.amount,
      confirmed_amount: '0',
      receiver: receiver.toLowerCase() as `0x${string}`,
      recovery: opts.recovery.toLowerCase() as `0x${string}`,
      salt,
      webhook_url: typeof req.webhook_url === 'string' ? req.webhook_url : undefined,
      expires_at: new Date(Number(expSecs) * 1000).toISOString(),
      tx_hash: null,
      block_number: null,
      failure: null,
      timestamps: { created_at: ts, updated_at: ts, detected_at: null, settled_at: null, failed_at: null, expired_at: null },
      events: [],
    };
    deposits.set(d.id, d);
    order.push(d);
    if (key) idempotency.set(key, { hash: raw, id: d.id });
    event(d, 'deposit.created');
    setTimeout(() => event(d, 'deposit.watch_registered'), 20);
    stats.created++;
    return c.json(view(d), 201);
  });

  app.get('/v1/deposit/id/:id', (c) => {
    const denied = authed(c);
    if (denied) return denied;
    const d = deposits.get(c.req.param('id'));
    return d ? c.json(view(d, true)) : err(404, 'not_found', 'no such deposit');
  });

  app.get('/v1/deposit', (c) => {
    const denied = authed(c);
    if (denied) return denied;
    const q = c.req.query();
    const limit = Number(q.limit ?? 50);
    if (!(limit >= 1 && limit <= 200)) return err(400, 'invalid_request', 'limit must be between 1 and 200');
    const after = q.created_after ? Date.parse(q.created_after) : -Infinity;
    const offset = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString()) : 0;
    const matches = [...order]
      .reverse()
      .filter((d) => Date.parse(d.timestamps.created_at) > after)
      .filter((d) => !q.status || d.status === q.status);
    const page = matches.slice(offset, offset + limit);
    const next = offset + limit < matches.length ? Buffer.from(String(offset + limit)).toString('base64url') : undefined;
    return c.json({ items: page.map((d) => view(d)), ...(next ? { next_cursor: next } : {}) });
  });

  // ---- indexer + engine simulation ----------------------------------------------------------

  async function watch(ch: MockChain) {
    const head = await ch.public.getBlockNumber({ cacheTime: 0 });
    const open = order.filter((d) => d.slug === ch.slug && (d.status === 'pending' || d.status === 'partial_paid'));
    await Promise.all(
      open.map(async (d) => {
        if (Date.now() > Date.parse(d.expires_at)) {
          d.status = 'expired';
          d.timestamps.expired_at = now();
          stats.expired++;
          event(d, 'deposit.expired');
          return;
        }
        const bal = await ch.public.readContract({ address: ch.token, abi: erc20Abi, functionName: 'balanceOf', args: [d.payment_address] });
        if (bal === 0n) return;
        if (!d._seenBlock) {
          d._seenBlock = head;
          d.timestamps.detected_at = now();
          event(d, 'deposit.detected', { amount: bal.toString() });
        }
        if (head - d._seenBlock >= confirmations) {
          d.confirmed_amount = bal.toString();
          event(d, 'deposit.payment_confirmed', { confirmed_amount: bal.toString() });
          if (bal >= BigInt(d.amount)) {
            d.status = 'paid';
            event(d, 'deposit.ready');
            void settle(ch, d);
          } else {
            d.status = 'partial_paid';
          }
        }
      }),
    );
  }

  const settleQueue = new Map<string, Promise<void>>();
  function settle(ch: MockChain, d: Deposit) {
    // One settler per chain: serialize so its nonces never collide.
    const prev = settleQueue.get(ch.slug) ?? Promise.resolve();
    const next = prev.then(() => doSettle(ch, d)).catch((e) => log(`settle error ${d.id}: ${(e as Error).message}`));
    settleQueue.set(ch.slug, next);
  }

  async function doSettle(ch: MockChain, d: Deposit) {
    if (d._settling) return;
    d._settling = true;
    if (Math.random() < (opts.failRate ?? 0)) {
      d.status = 'failed';
      d.failure = { code: 'simulated', message: 'mock settlement failure (MOCK_FAIL_RATE)' };
      d.timestamps.failed_at = now();
      stats.failed++;
      event(d, 'deposit.failed', d.failure);
      return;
    }
    event(d, 'deposit.settlement_submitted');
    const hash = await ch.settler.writeContract({
      account: ch.settlerAccount,
      chain: ch.chain,
      address: ch.factory,
      abi: factoryAbi,
      functionName: 'execute',
      args: [d.token_address, BigInt(d.amount), getAddress(d.receiver), BigInt(Math.floor(Date.parse(d.expires_at) / 1000)), d.recovery, d.salt, BigInt(d.chain_id)],
    });
    const receipt = await ch.public.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    event(d, 'deposit.settlement_included', { tx_hash: hash });
    if (receipt.status !== 'success') {
      d.status = 'failed';
      d.failure = { code: 'reverted', message: `execute ${hash} reverted` };
      d.timestamps.failed_at = now();
      stats.failed++;
      event(d, 'deposit.failed', d.failure);
      return;
    }
    // One more block, as the engine waits for confirmation.
    await new Promise((r) => setTimeout(r, 300));
    d.status = 'settled';
    d.tx_hash = hash;
    d.block_number = Number(receipt.blockNumber);
    d.timestamps.settled_at = now();
    stats.settled++;
    event(d, 'deposit.settled', { tx_hash: hash, block_number: Number(receipt.blockNumber) });
  }

  let stopped = false;
  for (const ch of opts.chains) {
    void (async () => {
      while (!stopped) {
        await watch(ch).catch((e) => log(`watch ${ch.slug}: ${(e as Error).message}`));
        await new Promise((r) => setTimeout(r, 400));
      }
    })();
  }

  const server = serve({ fetch: app.fetch, port: opts.port });
  return {
    stats,
    close() {
      stopped = true;
      server.close();
    },
  };
}
