import { useMemo, useState } from 'react';
import {
  CHAIN_COLOR,
  CHAIN_ORDER,
  HEALTH,
  STATUS_TONE,
  ago,
  chainLabel,
  compact,
  explorerAddr,
  explorerTx,
  ms,
  pct,
  short,
  units,
  usdc,
} from '../format.ts';
import type { Activity, ChainView, DepositView, Health, MoverView, Snapshot } from '../types.ts';
import { Sparkline, useMinuteSeries } from './charts.tsx';

// ---- small pieces ---------------------------------------------------------------------------

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? 'muted';
  const icon = status === 'settled' ? '●' : status === 'failed' ? '■' : status === 'expired' ? '▲' : '○';
  return (
    <span className={`status tone-${tone}`}>
      <span className="ico">{icon}</span>
      {status.replace('_', ' ')}
    </span>
  );
}

export function HealthBadge({ health }: { health: Health }) {
  const h = HEALTH[health];
  return (
    <span className={`status tone-${h.tone}`}>
      <span className="ico">{h.icon}</span>
      {h.label}
    </span>
  );
}

export function ChainTag({ slug }: { slug: string }) {
  return (
    <span className="status" style={{ fontWeight: 500 }}>
      <i className="dot" style={{ background: CHAIN_COLOR[slug] ?? 'var(--axis)' }} />
      {chainLabel(slug)}
    </span>
  );
}

function Link({ href, children }: { href?: string; children: React.ReactNode }) {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

// ---- KPI row --------------------------------------------------------------------------------

export function KpiRow({ snap }: { snap: Snapshot }) {
  const t = snap.totals;
  const chains = snap.chains.map((c) => c.slug);
  const series = useMinuteSeries(snap.throughput, chains, 'settled', 60, snap.now);
  const perMin = series.map((r) => Object.values(r.values).reduce((a, b) => a + b, 0));
  const hour = perMin.reduce((a, b) => a + b, 0);
  const outcomes = Object.values(snap.outcomes1h).reduce(
    (acc, o) => {
      for (const [k, v] of Object.entries(o)) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    },
    {} as Record<string, number>,
  );
  const done1h = (outcomes.settled ?? 0) + (outcomes.failed ?? 0) + (outcomes.expired ?? 0);
  const doneAll = t.settled + t.failed + (t.expired - t.expiredUnpaid);
  return (
    <div className="grid g-kpi">
      <div className="card tile hero">
        <div className="label">Settled deposits · all time</div>
        <div className="value">{compact(t.settled)}</div>
        <div className="foot">
          {hour.toLocaleString()} in the last hour · ${usdc(t.volumeSettled, snap.config.decimals)} volume
        </div>
        <Sparkline values={perMin} />
      </div>
      <Tile label="Deposits created" value={compact(t.created)} foot={`${t.createErrors} create errors`} />
      <Tile label="Paid by movers" value={compact(t.paid)} foot={`${t.payErrors} payment errors`} />
      <Tile
        label="Settlement success"
        value={pct(t.settled, doneAll)}
        foot={done1h ? `${pct(outcomes.settled ?? 0, done1h)} in the last hour` : 'no outcomes in the last hour'}
      />
      <Tile
        label="Failed · expired"
        value={`${compact(t.failed)} · ${compact(t.expired)}`}
        foot={`${t.expiredUnpaid} expired unpaid · ${t.addressMismatch} refused`}
        tone={t.failed + t.expired - t.expiredUnpaid > 0 ? 'critical' : undefined}
      />
      <Tile label="Open deposits" value={String(snap.open)} foot={`${t.topups} gas top-ups · ${t.cycles} cycles`} />
    </div>
  );
}

function Tile({ label, value, foot, tone }: { label: string; value: string; foot?: string; tone?: 'critical' }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className={`value ${tone ? `tone-${tone}` : ''}`}>{value}</div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

// ---- cycle ----------------------------------------------------------------------------------

export function CycleCard({ snap }: { snap: Snapshot }) {
  const { current, last, waiting, paused } = snap.runner;
  const c = current ?? last;
  const now = snap.now;
  let state: string;
  if (paused) state = 'Paused';
  else if (current?.phase === 'dispatching') state = 'Creating & paying';
  else if (current?.phase === 'settling') state = 'Awaiting settlement';
  else if (current?.phase === 'cooldown') state = `Next cycle in ${ms((current.nextAt ?? now) - now)}`;
  else if (waiting?.until) state = `Rate cap reached · next slot in ${ms(Math.max(waiting.until - now, 0))}`;
  else if (waiting) state = 'Waiting for ready movers';
  else state = 'Starting';

  const rows = c
    ? [
        { label: 'Planned', v: c.planned },
        { label: 'Created', v: c.created },
        { label: 'Paid', v: c.paid },
        { label: 'Settled', v: c.settled },
      ]
    : [];
  const skipped = waiting?.skipped ?? c?.skipped ?? {};
  return (
    <div className="card">
      <div className="card-h">
        <h2>{c ? `Cycle #${c.id}` : 'Cycle'}</h2>
        <span className="pill">
          <i className={`dot ${current && current.phase !== 'cooldown' ? 'live' : ''}`} style={{ background: paused ? 'var(--warning)' : 'var(--info)' }} />
          {state}
        </span>
      </div>
      {c ? (
        <>
          <div className="funnel">
            {rows.map((r) => (
              <div className="funnel-row" key={r.label}>
                <span className="secondary">{r.label}</span>
                <div className="bar">
                  <span style={{ width: `${c.planned ? (r.v / c.planned) * 100 : 0}%` }} />
                </div>
                <span className="num" style={{ textAlign: 'right' }}>
                  {r.v} / {c.planned}
                </span>
              </div>
            ))}
          </div>
          <dl className="kv" style={{ marginTop: 14 }}>
            <dt>Elapsed</dt>
            <dd>{ms((c.endedAt ?? now) - c.startedAt)}</dd>
            <dt>Failed · errors · carried over</dt>
            <dd>
              <span className={c.failed ? 'tone-critical' : ''}>{c.failed}</span> · <span className={c.errors ? 'tone-critical' : ''}>{c.errors}</span> · {c.carried}
            </dd>
          </dl>
        </>
      ) : (
        <div className="empty">No cycle has run yet.</div>
      )}
      {Object.keys(skipped).length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Movers sitting out{waiting ? ` (waiting ${ms(now - waiting.since)})` : ''}
          </div>
          <div className="chips">
            {Object.entries(skipped).map(([k, v]) => (
              <span className="chip" key={k}>
                {k.replace(/_/g, ' ')}: {v}
              </span>
            ))}
          </div>
        </div>
      )}
      <RateCapMeter snap={snap} />
      <CycleHistory snap={snap} />
    </div>
  );
}

function RateCapMeter({ snap }: { snap: Snapshot }) {
  const { limit, used } = snap.runner.rateCap;
  if (!limit) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
        <span className="muted">Deposit rate cap · rolling minute</span>
        <span className="num">
          <b>{used}</b> / {limit}
        </span>
      </div>
      <div className={`meter ${used >= limit ? 'warn' : ''}`}>
        <span style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
      </div>
    </div>
  );
}

function CycleHistory({ snap }: { snap: Snapshot }) {
  const cycles = snap.cycles.filter((c) => c.ended_at).slice(0, 12);
  if (!cycles.length) return null;
  const max = Math.max(...cycles.map((c) => c.ended_at! - c.started_at));
  return (
    <div style={{ marginTop: 14 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        Recent cycles · duration
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        {cycles.map((c) => {
          const d = c.ended_at! - c.started_at;
          const bad = c.failed + c.errors + c.carried > 0;
          return (
            <div key={c.id} className="funnel-row" style={{ gridTemplateColumns: '48px 1fr 150px', fontSize: 12 }} title={`cycle #${c.id}`}>
              <span className="muted num">#{c.id}</span>
              <div className="bar" style={{ height: 6 }}>
                <span style={{ width: `${(d / max) * 100}%`, background: bad ? 'var(--serious)' : undefined }} />
              </div>
              <span className="num" style={{ textAlign: 'right' }}>
                {ms(d)} · {c.settled}/{c.planned}
                {bad ? <span className="tone-critical"> ▲</span> : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Gum API --------------------------------------------------------------------------------

export function GumCard({ snap }: { snap: Snapshot }) {
  const g = snap.gum;
  const limit = snap.config.rateLimitRps;
  const statuses = Object.entries(g.byStatus).sort((a, b) => b[1] - a[1]);
  const ops: Array<[string, string]> = [
    ['create_deposit', 'POST /v1/deposit'],
    ['list_deposits', 'GET /v1/deposit'],
    ['get_deposit', 'GET /v1/deposit/id'],
  ];
  const bad = statuses.filter(([s]) => s === '429' || s === 'network' || s.startsWith('5')).reduce((a, [, n]) => a + n, 0);
  return (
    <div className="card">
      <div className="card-h">
        <h2>Gum API</h2>
        <span className="sub mono">{snap.config.apiUrl.replace(/^https?:\/\//, '')}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
        <span className="secondary">Request rate</span>
        <span className="num">
          <b>{g.rate}</b> / {limit} req/s{g.queued ? ` · ${g.queued} queued` : ''}
        </span>
      </div>
      <div className={`meter ${g.rate > limit * 0.9 ? 'warn' : ''}`}>
        <span style={{ width: `${Math.min(100, (g.rate / 50) * 100)}%` }} />
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        Gum's limit is 50/s per key; the bot caps itself at {limit}/s.
      </div>
      <table style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Endpoint</th>
            <th className="r">p50</th>
            <th className="r">p90</th>
            <th className="r">max</th>
          </tr>
        </thead>
        <tbody>
          {ops.map(([op, label]) => {
            const s = g.latency[op];
            return (
              <tr key={op}>
                <td className="mono">{label}</td>
                <td className="r">{ms(s?.p50)}</td>
                <td className="r">{ms(s?.p90)}</td>
                <td className="r">{ms(s?.max)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="chips" style={{ marginTop: 12 }}>
        <span className="chip">{g.requests.toLocaleString()} requests</span>
        {statuses.map(([s, n]) => (
          <span className="chip" key={s} style={s === '429' || s.startsWith('5') || s === 'network' ? { color: 'var(--critical)' } : undefined}>
            {s}: {n.toLocaleString()}
          </span>
        ))}
      </div>
      <dl className="kv" style={{ marginTop: 12 }}>
        <dt>Webhooks</dt>
        <dd>{snap.config.webhooks ? `on · ${snap.totals.webhooks.toLocaleString()} received` : 'off (polling only)'}</dd>
        <dt>Payment address verification</dt>
        <dd>{snap.config.verifyAddresses.length ? snap.config.verifyAddresses.map(chainLabel).join(', ') : 'off'}</dd>
        {bad > 0 && (
          <>
            <dt>Throttled / errored</dt>
            <dd className="tone-critical">{bad}</dd>
          </>
        )}
      </dl>
      {g.lastError && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Last poll error {ago(g.lastError.at, snap.now)}: {g.lastError.message}
        </div>
      )}
    </div>
  );
}

// ---- latency waterfall ----------------------------------------------------------------------

export function LatencyCard({ snap }: { snap: Snapshot }) {
  const chains = CHAIN_ORDER.filter((c) => snap.chains.some((x) => x.slug === c));
  const [chain, setChain] = useState<string>('all');
  const stages = snap.latency.stages.map((s) => ({ ...s, sum: chain === 'all' ? s.all : s.byChain[chain] }));
  let cursor = 0;
  const bars = stages.map((s) => {
    const start = cursor;
    cursor += s.sum?.p50 ?? 0;
    return { ...s, start };
  });
  const total = Math.max(cursor, 1);
  const color = chain === 'all' ? 'var(--seq-fill)' : CHAIN_COLOR[chain];
  const byChain = snap.latency.byChain;
  return (
    <div className="card">
      <div className="card-h">
        <h2>Where the time goes · median per stage</h2>
        <div className="seg" role="group" aria-label="Chain">
          {['all', ...chains].map((c) => (
            <button key={c} aria-pressed={chain === c} onClick={() => setChain(c)}>
              {c === 'all' ? 'All' : chainLabel(c)}
            </button>
          ))}
        </div>
      </div>
      {snap.latency.sample === 0 ? (
        <div className="empty">Waiting for the first settlements.</div>
      ) : (
        <div className="waterfall">
          {bars.map((b) => (
            <div className="wf-row" key={b.key} title={`p50 ${ms(b.sum?.p50)} · p90 ${ms(b.sum?.p90)} · p99 ${ms(b.sum?.p99)} · n=${b.sum?.n ?? 0}`}>
              <span className="secondary">{b.label}</span>
              <div className="lane">
                {b.sum?.p90 != null && (
                  <span className="p90" style={{ left: `${(b.start / total) * 100}%`, width: `${Math.min((b.sum.p90 / total) * 100, 100 - (b.start / total) * 100)}%`, background: color }} />
                )}
                <span className="seg-bar" style={{ left: `${(b.start / total) * 100}%`, width: `${((b.sum?.p50 ?? 0) / total) * 100}%`, background: color }} />
              </div>
              <span className="vals">
                {ms(b.sum?.p50)} <span className="muted">· p90 {ms(b.sum?.p90)}</span>
              </span>
            </div>
          ))}
          <div className="wf-row" style={{ borderTop: '1px solid var(--grid)', paddingTop: 7 }}>
            <b>Create → settled</b>
            <span className="muted" style={{ fontSize: 11 }}>
              bar = median, thin line = p90 · last hour, n={snap.latency.sample}
            </span>
            <span className="vals">
              <b>{ms(total)}</b>
            </span>
          </div>
        </div>
      )}
      <table style={{ marginTop: 14 }}>
        <thead>
          <tr>
            <th>Chain</th>
            <th className="r">Pay inclusion p50</th>
            <th className="r">Detect p50</th>
            <th className="r">Settle p50</th>
            <th className="r">Settle p90</th>
            <th className="r">End-to-end p50</th>
          </tr>
        </thead>
        <tbody>
          {chains.map((c) => {
            const l = byChain[c];
            return (
              <tr key={c}>
                <td>
                  <ChainTag slug={c} />
                </td>
                <td className="r">{ms(l?.inclusion.p50)}</td>
                <td className="r">{ms(l?.detect.p50)}</td>
                <td className="r">{ms(l?.settle.p50)}</td>
                <td className="r">{ms(l?.settle.p90)}</td>
                <td className="r">{ms(l?.e2e.p50)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Detect and settle are measured from the mover's payment receipt to Gum's timestamps.
      </div>
    </div>
  );
}

// ---- chains ---------------------------------------------------------------------------------

export function ChainCards({ snap }: { snap: Snapshot }) {
  const chains = CHAIN_ORDER.map((s) => snap.chains.find((c) => c.slug === s)).filter(Boolean) as ChainView[];
  return (
    <div className="grid g-3">
      {chains.map((c) => (
        <ChainCard key={c.slug} c={c} snap={snap} />
      ))}
    </div>
  );
}

function ChainCard({ c, snap }: { c: ChainView; snap: Snapshot }) {
  const movers = snap.movers.filter((m) => m.chain === c.slug);
  const healthCounts = movers.reduce(
    (acc, m) => ((acc[m.health] = (acc[m.health] ?? 0) + 1), acc),
    {} as Record<string, number>,
  );
  const lat = snap.latency.byChain[c.slug];
  const funderNative = Number(c.funder.native ?? 0);
  const funderRatio = Math.min(1, funderNative / (Number(c.funderMin) * 4));
  const t = c.totals;
  return (
    <div className="card">
      <div className="chain-h">
        <i className="dot" style={{ background: CHAIN_COLOR[c.slug], width: 10, height: 10 }} />
        <h3>{chainLabel(c.slug)}</h3>
        <span className="muted num" style={{ fontSize: 12 }}>
          {c.chainId}
        </span>
        <span className="right status">
          {c.rpcOk ? (
            <span className="tone-good">
              <span className="ico">●</span> RPC {c.rpcLatencyMs}ms
            </span>
          ) : (
            <span className="tone-critical">
              <span className="ico">■</span> RPC down
            </span>
          )}
        </span>
      </div>
      <div className="muted num" style={{ fontSize: 12 }}>
        block {c.block?.toLocaleString() ?? '—'} · balances {ago(c.updatedAt, snap.now)}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, margin: '10px 0 4px' }}>
        <span className="secondary">RPC calls</span>
        <span className="num">
          <b>{c.rpc.rate}</b> / {c.rpc.limit} per s{c.rpc.queued ? ` · ${c.rpc.queued} queued` : ''}
        </span>
      </div>
      <div className={`meter ${c.rpc.rate >= c.rpc.limit * 0.9 ? 'warn' : ''}`}>
        <span style={{ width: `${Math.min(100, (c.rpc.rate / c.rpc.limit) * 100)}%` }} />
      </div>
      <div className="chain-stats">
        <div>
          <div className="v num">{compact(t.settled)}</div>
          <div className="l">settled</div>
        </div>
        <div>
          <div className={`v num ${t.failed + t.expired - t.expiredUnpaid ? 'tone-critical' : ''}`}>{compact(t.failed + t.expired)}</div>
          <div className="l">failed · expired</div>
        </div>
        <div>
          <div className="v num">{c.open}</div>
          <div className="l">open</div>
        </div>
        <div>
          <div className="v num">{ms(lat?.settle.p50)}</div>
          <div className="l">settle p50</div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
        <span className="secondary">
          Funder <Link href={explorerAddr(c.explorerUrl, snap.config.funder)}>{short(snap.config.funder)}</Link>
        </span>
        <span className={`num ${c.funder.low ? 'tone-critical' : ''}`}>
          {units(c.funder.native)} {c.nativeSymbol}
        </span>
      </div>
      <div className={`meter ${c.funder.low ? 'crit' : ''}`}>
        <span style={{ width: `${funderRatio * 100}%` }} />
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        ≈{c.funder.topupsLeft?.toLocaleString() ?? '—'} top-ups left · alert below {c.funderMin} {c.nativeSymbol}
      </div>
      <dl className="kv" style={{ marginTop: 12 }}>
        <dt>Movers on chain</dt>
        <dd>
          {movers.length}{' '}
          {Object.entries(healthCounts)
            .filter(([h]) => h !== 'ok')
            .map(([h, n]) => (
              <span key={h} className={`tone-${HEALTH[h as Health].tone}`} style={{ marginLeft: 6 }}>
                {n} {HEALTH[h as Health].label.toLowerCase()}
              </span>
            ))}
        </dd>
        <dt>Gas threshold → top-up</dt>
        <dd>
          {c.gasMin} → {c.gasTopup} {c.nativeSymbol}
        </dd>
        <dt>Top-ups · failed</dt>
        <dd>
          {t.topups} · <span className={t.topupErrors ? 'tone-critical' : ''}>{t.topupErrors}</span>
        </dd>
        <dt>Volume settled</dt>
        <dd>${usdc(t.volumeSettled, c.token.decimals)}</dd>
        <dt>{c.token.symbol}</dt>
        <dd>
          <Link href={explorerAddr(c.explorerUrl, c.token.address)}>
            <span className="mono">{short(c.token.address)}</span>
          </Link>
        </dd>
      </dl>
    </div>
  );
}

// ---- movers ---------------------------------------------------------------------------------

type MoverFilter = 'all' | 'attention' | 'busy' | string;

export function MoverGrid({ snap, onOpen }: { snap: Snapshot; onOpen: (i: number) => void }) {
  const [filter, setFilter] = useState<MoverFilter>('all');
  const chains = CHAIN_ORDER.filter((c) => snap.chains.some((x) => x.slug === c));
  const attention = (m: MoverView) => m.health !== 'ok';
  const list = snap.movers.filter((m) =>
    filter === 'all' ? true : filter === 'attention' ? attention(m) : filter === 'busy' ? m.phase !== 'idle' : m.chain === filter,
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of snap.movers) c[m.health] = (c[m.health] ?? 0) + 1;
    return c;
  }, [snap.movers]);
  return (
    <>
      <div className="section-title">
        <span>
          Movers · {snap.movers.length}
          <span className="muted" style={{ fontWeight: 400, marginLeft: 10 }}>
            {Object.entries(counts).map(([h, n]) => (
              <span key={h} className={`status tone-${HEALTH[h as Health].tone}`} style={{ marginRight: 12, fontWeight: 500 }}>
                <span className="ico">{HEALTH[h as Health].icon}</span>
                {n} {HEALTH[h as Health].label.toLowerCase()}
              </span>
            ))}
          </span>
        </span>
        <div className="seg" role="group" aria-label="Filter movers">
          {['all', 'attention', 'busy', ...chains].map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'attention' ? `Needs attention (${snap.movers.filter(attention).length})` : f === 'busy' ? 'In flight' : chainLabel(f)}
            </button>
          ))}
        </div>
      </div>
      {list.length === 0 ? (
        <div className="card empty">Nothing here.</div>
      ) : (
        <div className="mover-grid">
          {list.map((m) => (
            <MoverTile key={m.index} m={m} snap={snap} onOpen={onOpen} />
          ))}
        </div>
      )}
    </>
  );
}

function MoverTile({ m, snap, onOpen }: { m: MoverView; snap: Snapshot; onOpen: (i: number) => void }) {
  const chain = snap.chains.find((c) => c.slug === m.chain);
  const ratio = m.gasRatio ?? 0;
  const phaseLabel = m.phase === 'idle' ? (m.last ? `last ${m.last.status}` : 'idle') : m.phase;
  return (
    <button className={`mover h-${m.health} ${m.enabled ? '' : 'disabled'}`} onClick={() => onOpen(m.index)} aria-label={`Mover ${m.index}`}>
      <div className="row">
        <span className="idx">#{m.index}</span>
        <HealthBadge health={m.health} />
      </div>
      <div className="row">
        <ChainTag slug={m.chain} />
        <span className={`phase ${m.phase !== 'idle' ? 'active' : ''}`}>
          <i className="dot" />
          {phaseLabel}
        </span>
      </div>
      <div className="row num">
        <span className="secondary">{m.token != null ? `${units(m.token, 3)} USDC` : '—'}</span>
        <span className="muted">
          {units(m.native, 3)} {chain?.nativeSymbol}
          {m.topupPending ? ' ⟳' : ''}
        </span>
      </div>
      <div className={`meter ${ratio < 1 ? (ratio === 0 ? 'crit' : 'warn') : ''}`} title={`gas at ${(ratio * 100).toFixed(0)}% of the top-up threshold`}>
        <span style={{ width: `${Math.min(ratio / 4, 1) * 100}%` }} />
      </div>
      <div className="row muted" style={{ fontSize: 11 }}>
        <span>
          {m.stats.settled} settled
          {m.stats.failed + m.stats.expired ? <span className="tone-critical"> · {m.stats.failed + m.stats.expired} lost</span> : null}
        </span>
        <span>{m.stats.topups} top-ups</span>
      </div>
    </button>
  );
}

// ---- deposits -------------------------------------------------------------------------------

export function DepositsTable({ snap, rows, onOpen }: { snap: Snapshot; rows: DepositView[]; onOpen: (id: string) => void }) {
  const explorer = (slug: string) => snap.chains.find((c) => c.slug === slug)?.explorerUrl;
  return (
    <div className="card">
      <div className="card-h">
        <h2>Recent deposits</h2>
        <span className="sub">live · click a row for its full timeline</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Created</th>
              <th>Cycle</th>
              <th>Mover</th>
              <th>Chain</th>
              <th>Status</th>
              <th>Payment</th>
              <th className="r">Create</th>
              <th className="r">Inclusion</th>
              <th className="r">Pay → settled</th>
              <th className="r">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => onOpen(d.id)}>
                <td className="muted">{ago(d.created_at, snap.now)}</td>
                <td className="muted">#{d.cycle}</td>
                <td>#{d.mover}</td>
                <td>
                  <ChainTag slug={d.chain} />
                </td>
                <td>
                  <StatusBadge status={d.status} />
                </td>
                <td>
                  {d.pay_tx ? (
                    <span onClick={(e) => e.stopPropagation()}>
                      <Link href={explorerTx(explorer(d.chain), d.pay_tx)}>
                        <span className="mono">{short(d.pay_tx)}</span>
                      </Link>
                      {d.pay_status !== 'mined' && <span className="muted"> {d.pay_status}</span>}
                    </span>
                  ) : (
                    <span className={d.pay_status === 'failed' || d.pay_status === 'skipped' ? 'tone-critical' : 'muted'}>{d.pay_status}</span>
                  )}
                </td>
                <td className="r">{ms(d.create_ms)}</td>
                <td className="r">{d.pay_mined_at && d.pay_sent_at ? ms(d.pay_mined_at - d.pay_sent_at) : '—'}</td>
                <td className="r">{d.settled_at && d.pay_mined_at ? ms(d.settled_at - d.pay_mined_at) : d.pay_mined_at && !d.terminal ? <span className="muted">{ms(snap.now - d.pay_mined_at)}…</span> : '—'}</td>
                <td className="r">{d.settled_at ? ms(d.settled_at - d.created_at) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">No deposits yet.</div>}
      </div>
    </div>
  );
}

// ---- activity -------------------------------------------------------------------------------

export function ActivityFeed({ items, now, freshIds }: { items: Activity[]; now: number; freshIds: Set<number> }) {
  const [level, setLevel] = useState<'all' | 'problems'>('all');
  const list = level === 'all' ? items : items.filter((a) => a.level !== 'info');
  return (
    <div className="card">
      <div className="card-h">
        <h2>Activity</h2>
        <div className="seg" role="group" aria-label="Activity filter">
          <button aria-pressed={level === 'all'} onClick={() => setLevel('all')}>
            All
          </button>
          <button aria-pressed={level === 'problems'} onClick={() => setLevel('problems')}>
            Problems
          </button>
        </div>
      </div>
      <div className="feed">
        {list.map((a) => (
          <div key={a.id} className={`feed-item ${a.level} ${freshIds.has(a.id) ? 'fresh' : ''}`}>
            <span className="muted num" title={new Date(a.ts).toLocaleString()}>
              {ago(a.ts, now)}
            </span>
            <span className="ico">{a.level === 'error' ? '■' : a.level === 'warn' ? '▲' : '●'}</span>
            <span>{a.message}</span>
          </div>
        ))}
        {list.length === 0 && <div className="empty">Quiet.</div>}
      </div>
    </div>
  );
}

// ---- top-ups --------------------------------------------------------------------------------

export function TopupsTable({ snap }: { snap: Snapshot }) {
  const explorer = (slug: string) => snap.chains.find((c) => c.slug === slug)?.explorerUrl;
  const sym = (slug: string) => snap.chains.find((c) => c.slug === slug)?.nativeSymbol ?? '';
  return (
    <div className="card">
      <div className="card-h">
        <h2>Gas top-ups</h2>
        <span className="sub">funder → mover</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Mover</th>
            <th>Chain</th>
            <th className="r">Amount</th>
            <th>Tx</th>
          </tr>
        </thead>
        <tbody>
          {snap.topups.map((t) => (
            <tr key={t.id}>
              <td className="muted">{ago(t.created_at, snap.now)}</td>
              <td>#{t.mover}</td>
              <td>
                <ChainTag slug={t.chain} />
              </td>
              <td className="r">
                {units(String(Number(BigInt(t.amount)) / 1e18))} {sym(t.chain)}
              </td>
              <td>
                {t.status === 'failed' ? (
                  <span className="tone-critical" title={t.error ?? ''}>
                    failed
                  </span>
                ) : (
                  <Link href={explorerTx(explorer(t.chain), t.tx)}>
                    <span className="mono">{short(t.tx)}</span>
                  </Link>
                )}
                {t.status === 'sent' && <span className="muted"> pending</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {snap.topups.length === 0 && <div className="empty">No top-ups yet.</div>}
    </div>
  );
}
