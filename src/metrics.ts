import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics on `GET /metrics`, for Grafana / alerting alongside the built-in dashboard. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'gumbot_process_' });

const r = { registers: [registry] };
const secs = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600];

export const m = {
  gumRequests: new Counter({ ...r, name: 'gumbot_gum_requests_total', help: 'Gum API requests', labelNames: ['op', 'status'] }),
  gumLatency: new Histogram({
    ...r,
    name: 'gumbot_gum_request_seconds',
    help: 'Gum API request latency',
    labelNames: ['op'],
    buckets: [0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5, 10],
  }),
  depositsCreated: new Counter({ ...r, name: 'gumbot_deposits_created_total', help: 'Deposits created', labelNames: ['chain'] }),
  depositCreateErrors: new Counter({
    ...r,
    name: 'gumbot_deposit_create_errors_total',
    help: 'Deposit creations that failed after retries',
    labelNames: ['chain', 'code'],
  }),
  depositOutcomes: new Counter({
    ...r,
    name: 'gumbot_deposit_outcomes_total',
    help: 'Deposits reaching a terminal status',
    labelNames: ['chain', 'status'],
  }),
  depositTransitions: new Counter({
    ...r,
    name: 'gumbot_deposit_transitions_total',
    help: 'Observed Gum status transitions',
    labelNames: ['chain', 'status'],
  }),
  addressMismatch: new Counter({
    ...r,
    name: 'gumbot_payment_address_mismatch_total',
    help: 'Deposits whose payment address or terms did not verify; never paid',
    labelNames: ['chain'],
  }),
  payments: new Counter({ ...r, name: 'gumbot_payments_total', help: 'USDC payments sent by movers', labelNames: ['chain', 'outcome'] }),
  payLatency: new Histogram({
    ...r,
    name: 'gumbot_payment_inclusion_seconds',
    help: 'Mover transfer broadcast → receipt',
    labelNames: ['chain'],
    buckets: secs,
  }),
  detectLatency: new Histogram({
    ...r,
    name: 'gumbot_detect_seconds',
    help: 'Payment receipt → Gum detected_at',
    labelNames: ['chain'],
    buckets: secs,
  }),
  settleLatency: new Histogram({
    ...r,
    name: 'gumbot_settlement_seconds',
    help: 'Payment receipt → Gum settled_at',
    labelNames: ['chain'],
    buckets: secs,
  }),
  e2eLatency: new Histogram({
    ...r,
    name: 'gumbot_end_to_end_seconds',
    help: 'Deposit created → settled',
    labelNames: ['chain'],
    buckets: secs,
  }),
  webhooks: new Counter({ ...r, name: 'gumbot_webhooks_total', help: 'Gum webhooks received', labelNames: ['type', 'outcome'] }),
  webhookLag: new Histogram({
    ...r,
    name: 'gumbot_webhook_lag_seconds',
    help: 'Gum event created_at → webhook received',
    labelNames: ['type'],
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  }),
  topups: new Counter({ ...r, name: 'gumbot_gas_topups_total', help: 'Gas top-ups from the funder', labelNames: ['chain', 'outcome'] }),
  cycles: new Counter({ ...r, name: 'gumbot_cycles_total', help: 'Completed cycles' }),
  cycleSeconds: new Histogram({ ...r, name: 'gumbot_cycle_seconds', help: 'Cycle duration', buckets: secs }),
  openDeposits: new Gauge({ ...r, name: 'gumbot_open_deposits', help: 'Deposits not yet terminal', labelNames: ['chain'] }),
  moverNative: new Gauge({ ...r, name: 'gumbot_mover_native_balance', help: 'Mover native balance (whole units)', labelNames: ['mover', 'chain'] }),
  moverToken: new Gauge({ ...r, name: 'gumbot_mover_token_balance', help: 'Mover USDC balance (whole units)', labelNames: ['mover', 'chain'] }),
  moversReady: new Gauge({ ...r, name: 'gumbot_movers', help: 'Movers by health', labelNames: ['health'] }),
  funderNative: new Gauge({ ...r, name: 'gumbot_funder_native_balance', help: 'Funder native balance (whole units)', labelNames: ['chain'] }),
  rpcErrors: new Counter({ ...r, name: 'gumbot_rpc_errors_total', help: 'RPC failures', labelNames: ['chain', 'op'] }),
  rpcLatency: new Gauge({ ...r, name: 'gumbot_rpc_latency_seconds', help: 'Latest RPC block-number latency', labelNames: ['chain'] }),
  paused: new Gauge({ ...r, name: 'gumbot_paused', help: '1 while the runner is paused' }),
  rateCapLimit: new Gauge({ ...r, name: 'gumbot_deposit_rate_cap', help: 'Max deposits created per rolling minute (0 = no cap)' }),
  rateCapUsed: new Gauge({ ...r, name: 'gumbot_deposits_last_minute', help: 'Deposits created in the last rolling minute' }),
};
