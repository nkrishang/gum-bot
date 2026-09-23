import { z } from 'zod';

/** The chains Gum supports. The slug is what `POST /v1/deposit` takes as `chain_id`. */
export const CHAIN_SLUGS = ['monad', 'base', 'arbitrum'] as const;
export type ChainSlug = (typeof CHAIN_SLUGS)[number];

/**
 * Fixed per-chain facts: Circle's native USDC (the same registry gum-server uses), the block explorer
 * for dashboard links, and the default gas thresholds. Gas numbers are in the chain's native unit
 * (MON / ETH) and are deliberately conservative: a USDC transfer costs well under the top-up amount.
 */
export const CHAIN_INFO: Record<ChainSlug, { usdc: `0x${string}`; explorer: string; gasMin: string; gasTopup: string; funderMin: string }> = {
  monad: { usdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', explorer: 'https://monadscan.com', gasMin: '0.5', gasTopup: '2', funderMin: '20' },
  base: { usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', explorer: 'https://basescan.org', gasMin: '0.00002', gasTopup: '0.0001', funderMin: '0.002' },
  arbitrum: { usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', explorer: 'https://arbiscan.io', gasMin: '0.00002', gasTopup: '0.0001', funderMin: '0.002' },
};
export const USDC_DECIMALS = 6;

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().nonnegative());
const str = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'must be a decimal number like 0.0001');
const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex private key');
const list = (v: string | undefined) =>
  (v ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export interface ChainConfig {
  slug: ChainSlug;
  rpcUrl: string;
  /** Max JSON-RPC calls per second to this chain's RPC; every call inside a batch counts. */
  rpcRps: number;
  /** Native balance below which a mover is topped up, and the top-up amount. Native units as decimal strings. */
  gasMin: string;
  gasTopup: string;
  /** Funder balance below which the dashboard raises an alert. */
  funderMin: string;
}

export interface Config {
  gum: {
    apiUrl: string;
    apiKey: string;
    rateLimitRps: number;
    rateLimitBurst: number;
    webhookSecret?: string;
  };
  publicUrl?: string;
  funderKey: `0x${string}`;
  movers: { privateKeys?: `0x${string}`[]; mnemonic?: string; count: number };
  chains: ChainConfig[];
  /** Weighted assignment order: mover i prefers rotation[i % rotation.length]. */
  moverChainRotation: ChainSlug[];
  deposit: { amount: bigint; expirySecs: number; maxPerMinute: number };
  cycle: { minIntervalMs: number; settleTimeoutMs: number; pollIntervalMs: number };
  balanceRefreshMs: number;
  fetchDepositEvents: boolean;
  startPaused: boolean;
  server: { port: number; dashboardUser: string; dashboardPassword?: string; metricsToken?: string };
  alerts: { webhookUrl?: string; stuckSecs: number; idleSecs: number };
  dataDir: string;
  retainDays: number;
  log: { level: string; pretty: boolean };
}

const EnvSchema = z.object({
  GUM_API_URL: str,
  GUM_API_KEY: str,
  GUM_RATE_LIMIT_RPS: int(40),
  GUM_RATE_LIMIT_BURST: int(60),
  GUM_WEBHOOK_SECRET: str,
  PUBLIC_URL: str,
  FUNDER_PRIVATE_KEY: str,
  MOVER_PRIVATE_KEYS: str,
  MOVER_MNEMONIC: str,
  MOVER_COUNT: int(50),
  CHAINS: str,
  MOVER_CHAIN_ROTATION: str,
  DEPOSIT_AMOUNT: str,
  DEPOSIT_EXPIRY_SECS: int(1800),
  MAX_DEPOSITS_PER_MINUTE: int(50),
  CYCLE_MIN_INTERVAL_MS: int(10_000),
  CYCLE_SETTLE_TIMEOUT_MS: int(600_000),
  STATUS_POLL_INTERVAL_MS: int(3_000),
  BALANCE_REFRESH_MS: int(15_000),
  FETCH_DEPOSIT_EVENTS: bool,
  START_PAUSED: bool,
  PORT: int(8080),
  DASHBOARD_USER: str,
  DASHBOARD_PASSWORD: str,
  METRICS_TOKEN: str,
  ALERT_WEBHOOK_URL: str,
  ALERT_STUCK_SECS: int(180),
  ALERT_IDLE_SECS: int(600),
  DATA_DIR: str,
  RETAIN_DAYS: int(30),
  LOG_LEVEL: str,
  LOG_FORMAT: str,
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Collect every problem before failing, so one run tells the operator everything that is missing.
  const problems: string[] = [];
  const parsed = EnvSchema.safeParse(env);
  let e: z.infer<typeof EnvSchema>;
  if (parsed.success) e = parsed.data;
  else {
    const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    for (const i of parsed.error.issues) problems.push(`${i.path.join('.')}: ${i.message}`);
    // Keep validating the rest with defaults in place of the malformed values.
    e = EnvSchema.parse(Object.fromEntries(Object.entries(env).filter(([k]) => !bad.has(k))));
  }

  if (!e.GUM_API_KEY) problems.push('GUM_API_KEY is required (a gum_sk_… key from the Gum web UI)');
  if (!e.FUNDER_PRIVATE_KEY) problems.push('FUNDER_PRIVATE_KEY is required');
  else if (!hexKey.safeParse(e.FUNDER_PRIVATE_KEY).success) problems.push('FUNDER_PRIVATE_KEY: must be a 0x-prefixed 32-byte hex private key');

  const enabled = list(e.CHAINS ?? CHAIN_SLUGS.join(','));
  const chains: ChainConfig[] = [];
  for (const slug of enabled) {
    if (!CHAIN_SLUGS.includes(slug as ChainSlug)) {
      problems.push(`CHAINS: unknown chain "${slug}" (supported: ${CHAIN_SLUGS.join(', ')})`);
      continue;
    }
    const s = slug as ChainSlug;
    const up = s.toUpperCase();
    const defaults = CHAIN_INFO[s];
    const rpcUrl = env[`RPC_URL_${up}`]?.trim();
    if (!rpcUrl) {
      problems.push(`RPC_URL_${up} is required (or remove ${s} from CHAINS)`);
      continue;
    }
    const rps = (key: string) => {
      const raw = env[key]?.trim() || '25';
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) problems.push(`${key}: a whole number of requests per second, e.g. 25`);
      return n;
    };
    const num = (key: string, def: string) => {
      const raw = env[key]?.trim() || def;
      const r = decimal.safeParse(raw);
      if (!r.success) problems.push(`${key}: ${r.error.issues[0]?.message}`);
      return raw;
    };
    chains.push({
      slug: s,
      rpcUrl,
      gasMin: num(`GAS_MIN_${up}`, defaults.gasMin),
      gasTopup: num(`GAS_TOPUP_${up}`, defaults.gasTopup),
      funderMin: num(`FUNDER_MIN_${up}`, defaults.funderMin),
      rpcRps: rps(`RPC_RPS_${up}`),
    });
  }
  if (chains.length === 0 && problems.length === 0) problems.push('CHAINS: at least one chain must be enabled');

  // Checked against CHAINS itself, so a missing RPC URL is reported once rather than again here.
  const known = enabled.filter((slug) => CHAIN_SLUGS.includes(slug as ChainSlug));
  const rotation = list(e.MOVER_CHAIN_ROTATION ?? known.join(','));
  for (const r of rotation) {
    if (!known.includes(r)) problems.push(`MOVER_CHAIN_ROTATION: "${r}" is not in CHAINS`);
  }

  let privateKeys: `0x${string}`[] | undefined;
  if (e.MOVER_PRIVATE_KEYS) {
    privateKeys = list(e.MOVER_PRIVATE_KEYS) as `0x${string}`[];
    privateKeys.forEach((k, i) => {
      if (!hexKey.safeParse(k).success) problems.push(`MOVER_PRIVATE_KEYS[${i}]: not a 32-byte hex private key`);
    });
  } else if (!e.MOVER_MNEMONIC) {
    problems.push('MOVER_PRIVATE_KEYS or MOVER_MNEMONIC is required (set one of them)');
  }
  const moverCount = privateKeys ? privateKeys.length : e.MOVER_COUNT;
  if (moverCount < 1) problems.push('need at least one mover');

  const amountRaw = e.DEPOSIT_AMOUNT ?? '1000000';
  if (!/^[1-9]\d*$/.test(amountRaw)) problems.push('DEPOSIT_AMOUNT: base-unit integer string, e.g. 1000000 = 1 USDC');

  if (e.DEPOSIT_EXPIRY_SECS < 360) problems.push('DEPOSIT_EXPIRY_SECS: Gum requires at least 300s of lead; use >= 360');
  if (e.GUM_RATE_LIMIT_RPS < 1 || e.GUM_RATE_LIMIT_RPS > 50) problems.push('GUM_RATE_LIMIT_RPS: 1..50 (Gum allows 50/s per key)');
  if (e.GUM_WEBHOOK_SECRET && !e.PUBLIC_URL) problems.push('GUM_WEBHOOK_SECRET is set but PUBLIC_URL is not; webhooks need a public URL');

  // A public dashboard can pause the bot and move funds: never serve it unauthenticated on Railway.
  if ((env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_NAME) && !e.DASHBOARD_PASSWORD) {
    problems.push('DASHBOARD_PASSWORD is required on Railway (the dashboard can pause the bot and trigger top-ups)');
  }
  if (e.ALERT_WEBHOOK_URL && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(e.ALERT_WEBHOOK_URL)) problems.push('ALERT_WEBHOOK_URL must be an https URL (Slack or Discord incoming webhook)');

  if (problems.length) throw new Error(`invalid configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);

  return {
    gum: {
      apiUrl: (e.GUM_API_URL ?? 'https://api.gum.money').replace(/\/+$/, ''),
      apiKey: e.GUM_API_KEY!,
      rateLimitRps: e.GUM_RATE_LIMIT_RPS,
      rateLimitBurst: Math.max(e.GUM_RATE_LIMIT_BURST, 1),
      webhookSecret: e.GUM_WEBHOOK_SECRET,
    },
    publicUrl: e.PUBLIC_URL?.replace(/\/+$/, ''),
    funderKey: e.FUNDER_PRIVATE_KEY! as `0x${string}`,
    movers: { privateKeys, mnemonic: e.MOVER_MNEMONIC, count: moverCount },
    chains,
    moverChainRotation: rotation as ChainSlug[],
    deposit: { amount: BigInt(amountRaw), expirySecs: e.DEPOSIT_EXPIRY_SECS, maxPerMinute: e.MAX_DEPOSITS_PER_MINUTE },
    cycle: {
      minIntervalMs: e.CYCLE_MIN_INTERVAL_MS,
      settleTimeoutMs: e.CYCLE_SETTLE_TIMEOUT_MS,
      pollIntervalMs: Math.max(e.STATUS_POLL_INTERVAL_MS, 500),
    },
    balanceRefreshMs: Math.max(e.BALANCE_REFRESH_MS, 2_000),
    fetchDepositEvents: e.FETCH_DEPOSIT_EVENTS ?? true,
    startPaused: e.START_PAUSED ?? false,
    server: {
      port: e.PORT,
      dashboardUser: e.DASHBOARD_USER ?? 'admin',
      dashboardPassword: e.DASHBOARD_PASSWORD,
      metricsToken: e.METRICS_TOKEN,
    },
    alerts: { webhookUrl: e.ALERT_WEBHOOK_URL, stuckSecs: Math.max(e.ALERT_STUCK_SECS, 30), idleSecs: Math.max(e.ALERT_IDLE_SECS, 60) },
    dataDir: e.DATA_DIR ?? './data',
    retainDays: e.RETAIN_DAYS,
    log: { level: e.LOG_LEVEL ?? 'info', pretty: e.LOG_FORMAT === 'pretty' },
  };
}
