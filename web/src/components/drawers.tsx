import { useEffect, useState } from 'react';
import { ago, explorerAddr, explorerTx, ms, short, units } from '../format.ts';
import type { DepositView, Snapshot } from '../types.ts';
import { ChainTag, HealthBadge, StatusBadge } from './panels.tsx';

function Drawer({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <button className="btn close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        {children}
      </aside>
    </>
  );
}

function useJson<T>(url: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(url)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((d) => live && setData(d as T))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  return { data, error };
}

// ---- mover ----------------------------------------------------------------------------------

interface MoverDetail {
  index: number;
  address: string;
  balances: Record<string, { native: string | null; token: string | null; at: number | null }>;
  deposits: DepositView[];
  topups: Array<{ id: number; chain: string; amount: string; tx: string | null; status: string; created_at: number }>;
}

export function MoverDrawer({ index, snap, onClose, onOpenDeposit }: { index: number; snap: Snapshot; onClose: () => void; onOpenDeposit: (id: string) => void }) {
  const m = snap.movers[index]!;
  // Refetch whenever the mover's own counters move.
  const { data } = useJson<MoverDetail>(`/api/movers/${index}`, [m.stats.created, m.stats.settled, m.stats.topups, m.phase]);
  const [busy, setBusy] = useState(false);
  const act = async (path: string) => {
    setBusy(true);
    await fetch(path, { method: 'POST' }).finally(() => setBusy(false));
  };
  const explorer = snap.chains.find((c) => c.slug === m.chain)?.explorerUrl;
  return (
    <Drawer onClose={onClose}>
      <h2>Mover #{m.index}</h2>
      <div className="mono secondary" style={{ margin: '4px 0 12px', wordBreak: 'break-all' }}>
        <a href={explorerAddr(explorer, m.address)} target="_blank" rel="noreferrer">
          {m.address}
        </a>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <HealthBadge health={m.health} />
        <ChainTag slug={m.chain} />
        {m.chain !== m.preferredChain && <span className="chip">prefers {m.preferredChain}</span>}
        <span className="chip">{m.phase}</span>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={busy || m.topupPending} onClick={() => act(`/api/movers/${index}/topup`)}>
          {m.topupPending ? 'Top-up pending…' : 'Top up gas'}
        </button>
        <button className={`btn ${m.enabled ? 'danger' : ''}`} disabled={busy} onClick={() => act(`/api/movers/${index}/${m.enabled ? 'disable' : 'enable'}`)}>
          {m.enabled ? 'Disable' : 'Enable'}
        </button>
      </div>
      {m.error && (
        <div className="alert error" style={{ marginBottom: 12 }}>
          <span className="ico">■</span>
          <span>
            {m.error.message} <span className="muted">({ago(m.error.at, snap.now)})</span>
          </span>
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>Chain</th>
            <th className="r">Native</th>
            <th className="r">USDC</th>
            <th className="r">Read</th>
          </tr>
        </thead>
        <tbody>
          {snap.chains.map((c) => {
            const b = data?.balances[c.slug];
            return (
              <tr key={c.slug}>
                <td>
                  <ChainTag slug={c.slug} />
                </td>
                <td className="r">
                  {b?.native != null ? units(String(Number(BigInt(b.native)) / 1e18)) : '—'} {c.nativeSymbol}
                </td>
                <td className="r">{b?.token != null ? units(String(Number(BigInt(b.token)) / 10 ** c.token.decimals)) : '—'}</td>
                <td className="r muted">{ago(b?.at, snap.now)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <dl className="kv" style={{ marginTop: 16 }}>
        {Object.entries(m.stats).map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h3 style={{ fontSize: 13, marginTop: 20 }}>Deposits</h3>
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Chain</th>
            <th>Status</th>
            <th className="r">Pay → settled</th>
          </tr>
        </thead>
        <tbody>
          {(data?.deposits ?? []).map((d) => (
            <tr key={d.id} className="clickable" onClick={() => onOpenDeposit(d.id)}>
              <td className="muted">{ago(d.created_at, snap.now)}</td>
              <td>
                <ChainTag slug={d.chain} />
              </td>
              <td>
                <StatusBadge status={d.status} />
              </td>
              <td className="r">{d.settled_at && d.pay_mined_at ? ms(d.settled_at - d.pay_mined_at) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && data.topups.length > 0 && (
        <>
          <h3 style={{ fontSize: 13, marginTop: 20 }}>Top-ups</h3>
          <table>
            <tbody>
              {data.topups.map((t) => (
                <tr key={t.id}>
                  <td className="muted">{ago(t.created_at, snap.now)}</td>
                  <td>
                    <ChainTag slug={t.chain} />
                  </td>
                  <td className="r">{units(String(Number(BigInt(t.amount)) / 1e18))}</td>
                  <td>{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Drawer>
  );
}

// ---- deposit --------------------------------------------------------------------------------

interface DepositDetail {
  deposit: DepositView;
  gum: {
    error?: string;
    status?: string;
    recovery?: string;
    salt?: string;
    expires_at?: string;
    events?: Array<{ id: string; type: string; created_at: string; data: unknown }>;
  };
}

export function DepositDrawer({ id, snap, onClose }: { id: string; snap: Snapshot; onClose: () => void }) {
  const live = snap.recentDeposits.find((d) => d.id === id);
  const { data, error } = useJson<DepositDetail>(`/api/deposits/${id}`, [live?.status, live?.pay_status]);
  const d = data?.deposit ?? live;
  if (!d) return <Drawer onClose={onClose}>{error ? <div className="empty">{error}</div> : <div className="empty">Loading…</div>}</Drawer>;
  const explorer = snap.chains.find((c) => c.slug === d.chain)?.explorerUrl;

  type Step = { at: number; label: string; kind: 'local' | 'gum' | 'done' | 'bad'; detail?: React.ReactNode };
  const steps: Step[] = [];
  if (d.create_ms != null) steps.push({ at: d.created_at - d.create_ms, label: 'POST /v1/deposit sent', kind: 'local' });
  steps.push({ at: d.created_at, label: `created (${ms(d.create_ms)})`, kind: 'local' });
  if (d.pay_sent_at)
    steps.push({
      at: d.pay_sent_at,
      label: 'mover broadcast USDC transfer',
      kind: 'local',
      detail: d.pay_tx ? (
        <a href={explorerTx(explorer, d.pay_tx)} target="_blank" rel="noreferrer" className="mono">
          {short(d.pay_tx, 6)}
        </a>
      ) : undefined,
    });
  if (d.pay_mined_at) steps.push({ at: d.pay_mined_at, label: 'transfer included', kind: 'local' });
  if (d.pay_error) steps.push({ at: d.updated_at ?? d.created_at, label: `payment problem: ${d.pay_error}`, kind: 'bad' });
  for (const e of data?.gum.events ?? []) {
    const bad = e.type === 'deposit.failed' || e.type === 'deposit.expired';
    const done = e.type === 'deposit.settled';
    const hook = d.webhooks?.[e.type];
    steps.push({
      at: Date.parse(e.created_at),
      label: `gum: ${e.type.replace('deposit.', '')}`,
      kind: bad ? 'bad' : done ? 'done' : 'gum',
      detail: hook ? <span className="muted">webhook +{ms(hook.lagMs)}</span> : undefined,
    });
  }
  steps.sort((a, b) => a.at - b.at);
  const t0 = steps[0]?.at ?? d.created_at;

  return (
    <Drawer onClose={onClose}>
      <h2>Deposit</h2>
      <div className="mono secondary" style={{ margin: '4px 0 12px' }}>
        {d.id}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <StatusBadge status={d.status} />
        <ChainTag slug={d.chain} />
        <span className="chip">mover #{d.mover}</span>
        <span className="chip">cycle #{d.cycle}</span>
      </div>
      {d.failure_code && (
        <div className="alert error" style={{ marginBottom: 12 }}>
          <span className="ico">■</span>
          <span>
            {d.failure_code}: {d.failure_message}
          </span>
        </div>
      )}
      <dl className="kv">
        <dt>Payment address</dt>
        <dd className="mono">
          <a href={explorerAddr(explorer, d.payment_address)} target="_blank" rel="noreferrer">
            {short(d.payment_address, 6)}
          </a>
        </dd>
        <dt>Receiver (mover)</dt>
        <dd className="mono">{short(d.mover_address, 6)}</dd>
        <dt>Amount</dt>
        <dd>{Number(d.amount) / 1e6} USDC</dd>
        <dt>Expires</dt>
        <dd>{new Date(d.expires_at).toLocaleTimeString()}</dd>
        {d.settle_tx && (
          <>
            <dt>Settlement tx</dt>
            <dd className="mono">
              <a href={explorerTx(explorer, d.settle_tx)} target="_blank" rel="noreferrer">
                {short(d.settle_tx, 6)}
              </a>
            </dd>
          </>
        )}
        {d.pay_gas_cost && (
          <>
            <dt>Payment gas</dt>
            <dd>
              {units(String(Number(BigInt(d.pay_gas_cost)) / 1e18))} {snap.chains.find((c) => c.slug === d.chain)?.nativeSymbol}
            </dd>
          </>
        )}
        {d.settled_at && (
          <>
            <dt>Created → settled</dt>
            <dd>
              <b>{ms(d.settled_at - d.created_at)}</b>
            </dd>
          </>
        )}
      </dl>
      <h3 style={{ fontSize: 13, marginTop: 20 }}>Timeline</h3>
      <div className="timeline">
        {steps.map((s, i) => (
          <div key={i} className={`tl-item ${s.kind}`}>
            <i className="d" />
            <span>
              {s.label} {s.detail}
            </span>
            <span className="muted num">+{ms(s.at - t0)}</span>
          </div>
        ))}
      </div>
      {data?.gum.error && <div className="muted" style={{ fontSize: 12 }}>Could not load Gum's timeline: {data.gum.error}</div>}
    </Drawer>
  );
}
