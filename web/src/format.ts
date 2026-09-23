import type { Health } from './types.ts';

/** Chains are the only categorical series; slots 1–3 of the palette validate all-pairs. */
export const CHAIN_COLOR: Record<string, string> = {
  base: 'var(--series-1)',
  monad: 'var(--series-2)',
  arbitrum: 'var(--series-3)',
};
export const CHAIN_ORDER = ['monad', 'base', 'arbitrum'];
export const chainLabel = (slug: string) => slug.charAt(0).toUpperCase() + slug.slice(1);

export function ms(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(v / 60_000);
  return `${m}m ${Math.round((v % 60_000) / 1000)}s`;
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(msv: number): string {
  const s = Math.floor(msv / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function compact(n: number): string {
  if (Math.abs(n) < 10_000) return n.toLocaleString('en-US');
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function units(raw: string | null | undefined, digits = 4): string {
  if (raw == null) return '—';
  const n = Number(raw);
  if (n === 0) return '0';
  if (Math.abs(n) >= 1000) return compact(Math.round(n));
  if (Math.abs(n) >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return n.toPrecision(digits).replace(/0+$/, '').replace(/\.$/, '');
}

export function usdc(baseUnits: string, decimals = 6): string {
  const n = Number(BigInt(baseUnits)) / 10 ** decimals;
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export const short = (a: string | null | undefined, n = 4) => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : '—');

export const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(a === b ? 0 : 1)}%` : '—');

export const HEALTH: Record<Health, { label: string; tone: 'good' | 'warning' | 'serious' | 'critical' | 'muted'; icon: string }> = {
  ok: { label: 'Healthy', tone: 'good', icon: '●' },
  low_gas: { label: 'Low gas', tone: 'warning', icon: '▲' },
  no_gas: { label: 'No gas', tone: 'critical', icon: '■' },
  no_token: { label: 'No USDC', tone: 'critical', icon: '■' },
  error: { label: 'Error', tone: 'serious', icon: '◆' },
  disabled: { label: 'Disabled', tone: 'muted', icon: '○' },
  unknown: { label: 'Loading', tone: 'muted', icon: '○' },
};

export const STATUS_TONE: Record<string, 'good' | 'warning' | 'serious' | 'critical' | 'muted' | 'info'> = {
  pending: 'muted',
  partial_paid: 'info',
  paid: 'info',
  settled: 'good',
  failed: 'critical',
  expired: 'serious',
};

export function explorerTx(base: string | null | undefined, hash: string | null | undefined) {
  return base && hash ? `${base}/tx/${hash}` : undefined;
}
export function explorerAddr(base: string | null | undefined, addr: string | null | undefined) {
  return base && addr ? `${base}/address/${addr}` : undefined;
}
