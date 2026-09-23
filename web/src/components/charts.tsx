import { useMemo, useRef, useState } from 'react';
import { CHAIN_COLOR, CHAIN_ORDER, chainLabel } from '../format.ts';
import type { Snapshot } from '../types.ts';

type Bucket = Snapshot['throughput'][number];

/** Per-minute series for the last `minutes`, zero-filled, keyed by chain. */
export function useMinuteSeries(throughput: Bucket[], chains: string[], field: 'settled' | 'created' | 'failed', minutes = 60, now = Date.now()) {
  return useMemo(() => {
    const end = Math.floor(now / 60_000);
    const start = end - minutes + 1;
    const rows = Array.from({ length: minutes }, (_, i) => ({
      minute: start + i,
      values: Object.fromEntries(chains.map((c) => [c, 0])) as Record<string, number>,
    }));
    for (const b of throughput) {
      const i = b.minute - start;
      if (i >= 0 && i < minutes && b.chain in rows[i]!.values) rows[i]!.values[b.chain]! += b[field];
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [throughput, chains.join(','), field, minutes, Math.floor(now / 10_000)]);
}

const clock = (minute: number) => new Date(minute * 60_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Stacked columns: settled deposits per minute by chain, with a per-column hover readout. */
export function ThroughputChart({ snap }: { snap: Snapshot }) {
  const chains = CHAIN_ORDER.filter((c) => snap.chains.some((x) => x.slug === c));
  const [field, setField] = useState<'settled' | 'created' | 'failed'>('settled');
  const rows = useMinuteSeries(snap.throughput, chains, field, 60, snap.now);
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const W = 720;
  const H = 200;
  const padL = 36;
  const padB = 22;
  const padT = 8;
  const plotW = W - padL;
  const plotH = H - padB - padT;
  const totals = rows.map((r) => Object.values(r.values).reduce((a, b) => a + b, 0));
  const max = niceMax(Math.max(1, ...totals));
  const ticks = [0, max / 2, max];
  const band = plotW / rows.length;
  const barW = Math.min(24, Math.max(band - 2, 1));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const total = totals.reduce((a, b) => a + b, 0);
  const lastMin = totals.slice(-5).reduce((a, b) => a + b, 0) / 5;

  const hovered = hover !== null ? rows[hover] : undefined;
  return (
    <div className="card">
      <div className="card-h">
        <h2>Throughput · per minute, last hour</h2>
        <div className="seg" role="group" aria-label="Metric">
          {(['settled', 'created', 'failed'] as const).map((f) => (
            <button key={f} aria-pressed={field === f} onClick={() => setField(f)}>
              {f === 'failed' ? 'Failed / expired' : f[0]!.toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="legend" style={{ marginBottom: 8 }}>
        {chains.map((c) => (
          <span key={c}>
            <i className="sw" style={{ background: CHAIN_COLOR[c] }} />
            {chainLabel(c)}
          </span>
        ))}
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {total.toLocaleString()} in the hour · {lastMin.toFixed(1)}/min over the last 5 min
        </span>
      </div>
      <div className="chart" ref={ref} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${field} deposits per minute by chain`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} />
              <text x={padL - 6} y={y(t) + 4} textAnchor="end">
                {formatTick(t)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const x = padL + i * band + (band - barW) / 2;
            let acc = 0;
            const segs = chains.filter((c) => r.values[c]! > 0);
            return (
              <g key={r.minute} opacity={hover === null || hover === i ? 1 : 0.55}>
                {segs.map((c, si) => {
                  const v = r.values[c]!;
                  const y0 = y(acc);
                  acc += v;
                  const y1 = y(acc);
                  const top = si === segs.length - 1;
                  const h = Math.max(y0 - y1 - (si > 0 ? 2 : 0), 1);
                  return <path key={c} d={barPath(x, y1, barW, h, top ? Math.min(4, barW / 2, h) : 0)} fill={CHAIN_COLOR[c]} />;
                })}
                <rect
                  x={padL + i * band}
                  y={padT}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                  tabIndex={-1}
                />
              </g>
            );
          })}
          {[0, 15, 30, 45, 59].map((i) => (
            <text key={i} x={padL + i * band + band / 2} y={H - 4} textAnchor={i === 59 ? 'end' : i === 0 ? 'start' : 'middle'}>
              {clock(rows[i]!.minute)}
            </text>
          ))}
        </svg>
        {hovered && (
          <div
            className="tooltip"
            style={{ left: `min(calc(${((padL + hover! * band) / W) * 100}% + 12px), calc(100% - 170px))`, top: 4 }}
          >
            <div className="t-title">{clock(hovered.minute)}</div>
            {chains.map((c) => (
              <div className="t-row" key={c}>
                <i className="key" style={{ background: CHAIN_COLOR[c] }} />
                <span className="secondary">{chainLabel(c)}</span>
                <b>{hovered.values[c]}</b>
              </div>
            ))}
            <div className="t-row">
              <i />
              <span className="secondary">Total</span>
              <b>{totals[hover!]}</b>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Small trend line for the hero tile: one series, no axes, the latest value marked. */
export function Sparkline({ values, width = 240, height = 44 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(1, ...values);
  const step = width / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => [i * step, height - 4 - (v / max) * (height - 8)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${d}L${width},${height}L0,${height}Z`} fill="var(--series-3)" opacity={0.1} />
      <path d={d} fill="none" stroke="var(--series-3)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {last && <circle cx={last[0]} cy={last[1]} r={4} fill="var(--series-3)" stroke="var(--surface-1)" strokeWidth={2} />}
    </svg>
  );
}

function barPath(x: number, y: number, w: number, h: number, r: number) {
  if (r <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceMax(v: number) {
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

function formatTick(v: number) {
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : String(Math.round(v * 10) / 10);
}
