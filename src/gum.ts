import { TokenBucket } from './ratelimit.ts';

export type DepositStatus = 'pending' | 'partial_paid' | 'paid' | 'settled' | 'failed' | 'expired';
export const TERMINAL: ReadonlySet<DepositStatus> = new Set(['settled', 'failed', 'expired']);

export interface GumDeposit {
  id: string;
  status: DepositStatus;
  payment_address: `0x${string}`;
  chain_id: number;
  token: string;
  token_address: `0x${string}`;
  token_decimals: number;
  amount: string;
  confirmed_amount: string;
  receiver: string;
  recovery: `0x${string}`;
  salt: `0x${string}`;
  expires_at: string;
  tx_hash?: string | null;
  block_number?: number | null;
  failure?: { code: string; message: string } | null;
  timestamps: {
    created_at: string;
    updated_at: string;
    detected_at?: string | null;
    settled_at?: string | null;
    failed_at?: string | null;
    expired_at?: string | null;
  };
  events?: Array<{ id: string; sequence: number; type: string; data: unknown; created_at: string }>;
}

export interface GumChain {
  name: string;
  chain_id: number;
  factory: string;
  tokens: Array<{ symbol: string; address: `0x${string}`; decimals: number }>;
}

export interface CreateDepositInput {
  chain_id: string;
  token: string;
  amount: string;
  receiver: string;
  expires_at: string;
  webhook_url?: string;
}

export class GumError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
  /** Worth retrying with the same idempotency key. */
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export type GumObserver = (op: string, status: number, ms: number) => void;

export class GumClient {
  readonly limiter: TokenBucket;
  private observer: GumObserver = () => {};

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    rps: number,
    burst: number,
  ) {
    this.limiter = new TokenBucket(rps, burst);
  }

  onRequest(observer: GumObserver) {
    this.observer = observer;
  }

  /** Public; used to resolve token addresses. Not rate limited by Gum (no key). */
  async chains(): Promise<GumChain[]> {
    const body = await this.request<{ chains: GumChain[] }>('chains', 'GET', '/v1/chains', { auth: false });
    return body.chains;
  }

  async createDeposit(input: CreateDepositInput, idempotencyKey: string): Promise<{ deposit: GumDeposit; replayed: boolean }> {
    let replayed = false;
    const deposit = await this.request<GumDeposit>('create_deposit', 'POST', '/v1/deposit', {
      body: input,
      headers: { 'idempotency-key': idempotencyKey },
      retries: 4,
      onResponse: (res) => {
        replayed = res.headers.get('idempotent-replayed') === 'true';
      },
    });
    return { deposit, replayed };
  }

  getDeposit(id: string): Promise<GumDeposit> {
    return this.request<GumDeposit>('get_deposit', 'GET', `/v1/deposit/id/${encodeURIComponent(id)}`, { retries: 2 });
  }

  listDeposits(query: Record<string, string | number | undefined>): Promise<{ items: GumDeposit[]; next_cursor?: string }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    return this.request('list_deposits', 'GET', `/v1/deposit?${qs}`, { retries: 2 });
  }

  private async request<T>(
    op: string,
    method: string,
    path: string,
    opts: {
      body?: unknown;
      headers?: Record<string, string>;
      auth?: boolean;
      retries?: number;
      onResponse?: (res: Response) => void;
    } = {},
  ): Promise<T> {
    const retries = opts.retries ?? 0;
    for (let attempt = 0; ; attempt++) {
      if (opts.auth !== false) await this.limiter.take();
      const started = performance.now();
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            accept: 'application/json',
            ...(opts.body ? { 'content-type': 'application/json' } : {}),
            ...(opts.auth !== false ? { authorization: `Bearer ${this.apiKey}` } : {}),
            ...opts.headers,
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        this.observer(op, 0, performance.now() - started);
        const e = new GumError(0, 'network', `${method} ${path}: ${(err as Error).message}`);
        if (attempt < retries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw e;
      }
      this.observer(op, res.status, performance.now() - started);
      const requestId = res.headers.get('x-request-id') ?? undefined;
      if (res.ok) {
        opts.onResponse?.(res);
        return (await res.json()) as T;
      }
      let code = 'http_error';
      let message = `${method} ${path} → ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code ?? code;
        message = `${message}: ${body.error?.message ?? code}`;
      } catch {
        /* non-JSON error body */
      }
      const err = new GumError(res.status, code, message, requestId);
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        this.limiter.penalize(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000);
      }
      if (err.retryable && attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw err;
    }
  }
}

const backoff = (attempt: number) => Math.min(250 * 2 ** attempt, 5_000) * (0.75 + Math.random() * 0.5);
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
