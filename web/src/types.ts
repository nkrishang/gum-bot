// Mirrors src/snapshot.ts — the payload pushed over /api/stream once a second.

export type Health = 'ok' | 'low_gas' | 'no_gas' | 'no_token' | 'error' | 'disabled' | 'unknown';
export type Phase = 'idle' | 'creating' | 'paying' | 'settling';

export interface Summary {
  n: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
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
  volumeSettled: string;
  topups: number;
  topupErrors: number;
  addressMismatch: number;
  cycles: number;
  webhooks: number;
}

export interface Cycle {
  id: number;
  phase: 'dispatching' | 'settling' | 'cooldown';
  startedAt: number;
  endedAt: number | null;
  planned: number;
  created: number;
  paid: number;
  settled: number;
  failed: number;
  carried: number;
  errors: number;
  skipped: Record<string, number>;
  nextAt: number | null;
}

export interface ChainView {
  slug: string;
  chainId: number;
  nativeSymbol: string;
  explorerUrl: string | null;
  token: { address: string; decimals: number; symbol: string };
  gasMin: string;
  gasTopup: string;
  funderMin: string;
  block: number | null;
  rpcLatencyMs: number | null;
  rpc: { rate: number; limit: number; queued: number };
  rpcOk: boolean;
  rpcError: { message: string; at: number } | null;
  updatedAt: number | null;
  funder: { native: string | null; token: string | null; low: boolean; topupsLeft: number | null };
  movers: number;
  open: number;
  totals: Totals;
}

export interface MoverView {
  index: number;
  address: string;
  chain: string;
  preferredChain: string;
  phase: Phase;
  health: Health;
  enabled: boolean;
  native: string | null;
  token: string | null;
  gasRatio: number | null;
  topupPending: boolean;
  active: { id: string; status: string; pay: string; since: number; tx: string | null } | null;
  last: { id: string; status: string; at: number } | null;
  error: { message: string; at: number } | null;
  stats: { created: number; paid: number; settled: number; failed: number; expired: number; errors: number; topups: number };
}

export interface DepositView {
  id: string;
  cycle: number;
  mover: number;
  mover_address: string;
  chain: string;
  payment_address: string;
  token_address: string;
  amount: string;
  status: string;
  pay_status: string;
  pay_tx: string | null;
  pay_error: string | null;
  pay_gas_cost: string | null;
  create_ms: number | null;
  created_at: number;
  gum_created_at: number | null;
  expires_at: number;
  pay_sent_at: number | null;
  pay_mined_at: number | null;
  pay_block: number | null;
  pay_landed_at: number | null;
  detected_at: number | null;
  ready_at: number | null;
  settled_at: number | null;
  terminal_at: number | null;
  settle_tx: string | null;
  failure_code: string | null;
  failure_message: string | null;
  stages: Record<string, number> | null;
  webhooks: Record<string, { receivedAt: number; lagMs: number }> | null;
  updated_at: number;
  terminal: number;
}

export interface Activity {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  data: string | null;
}

export interface Stage {
  key: string;
  label: string;
  all: Summary;
  byChain: Record<string, Summary>;
}

export interface Snapshot {
  now: number;
  startedAt: number;
  runner: {
    paused: boolean;
    current: Cycle | null;
    last: Cycle | null;
    waiting: { since: number; skipped: Record<string, number>; until?: number } | null;
    rateCap: { limit: number; used: number; nextFreeAt: number };
  };
  config: {
    apiUrl: string;
    token: string;
    amount: string;
    decimals: number;
    moverCount: number;
    rateLimitRps: number;
    webhooks: boolean;
    verifyAddresses: string[];
    cycleMinIntervalMs: number;
    settleTimeoutMs: number;
    funder: string;
  };
  gum: {
    rate: number;
    queued: number;
    requests: number;
    byStatus: Record<string, number>;
    latency: Record<string, Summary>;
    lastError: { message: string; at: number } | null;
  };
  totals: Totals;
  open: number;
  chains: ChainView[];
  movers: MoverView[];
  latency: {
    byChain: Record<string, { settle: Summary; detect: Summary; e2e: Summary; inclusion: Summary; create: Summary; receiptLag: Summary }>;
    stages: Stage[];
    sample: number;
  };
  throughput: Array<{ minute: number; chain: string; created: number; settled: number; failed: number }>;
  outcomes1h: Record<string, Record<string, number>>;
  alerts: Array<{ level: 'warn' | 'error'; message: string }>;
  recentDeposits: DepositView[];
  activity: Activity[];
  cycles: Array<{ id: number; started_at: number; ended_at: number | null; planned: number; created: number; paid: number; settled: number; failed: number; carried: number; errors: number }>;
  topups: Array<{ id: number; chain: string; mover: number; address: string; amount: string; tx: string | null; status: string; error: string | null; created_at: number; mined_at: number | null }>;
}
