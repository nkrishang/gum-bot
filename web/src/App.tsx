import { useCallback, useEffect, useRef, useState } from 'react';
import { ThroughputChart } from './components/charts.tsx';
import { DepositDrawer, MoverDrawer } from './components/drawers.tsx';
import {
  ActivityFeed,
  ChainCards,
  CycleCard,
  DepositsTable,
  GumCard,
  KpiRow,
  LatencyCard,
  MoverGrid,
  TopupsTable,
} from './components/panels.tsx';
import { ago, duration, short } from './format.ts';
import type { Activity, Snapshot } from './types.ts';

/** One EventSource carries everything: a full snapshot every second, activity rows as they happen. */
function useLiveSnapshot() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastAt, setLastAt] = useState(0);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const seen = useRef(new Set<number>());

  useEffect(() => {
    let es: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      es = new EventSource('/api/stream');
      es.addEventListener('open', () => setConnected(true));
      es.addEventListener('snapshot', (e) => {
        const s = JSON.parse((e as MessageEvent).data) as Snapshot;
        setSnap(s);
        setLastAt(Date.now());
        setActivity((prev) => mergeActivity(prev, s.activity));
        for (const a of s.activity) seen.current.add(a.id);
      });
      es.addEventListener('activity', (e) => {
        const a = JSON.parse((e as MessageEvent).data) as Activity;
        if (seen.current.has(a.id)) return;
        seen.current.add(a.id);
        setActivity((prev) => mergeActivity(prev, [a]));
        setFresh((f) => new Set(f).add(a.id));
        setTimeout(() => setFresh((f) => {
          const n = new Set(f);
          n.delete(a.id);
          return n;
        }), 1600);
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      es?.close();
      clearTimeout(retry);
    };
  }, []);
  return { snap, connected, lastAt, activity, fresh };
}

function mergeActivity(prev: Activity[], incoming: Activity[]) {
  const byId = new Map(prev.map((a) => [a.id, a]));
  for (const a of incoming) byId.set(a.id, a);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, 200);
}

export function App() {
  const { snap, connected, lastAt, activity, fresh } = useLiveSnapshot();
  const [mover, setMover] = useState<number | null>(null);
  const [deposit, setDeposit] = useState<string | null>(null);
  const [theme, setTheme] = useState<string | null>(() => {
    try {
      return localStorage.getItem('gumbot-theme');
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      if (theme) localStorage.setItem('gumbot-theme', theme);
      else localStorage.removeItem('gumbot-theme');
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const control = useCallback(async (action: 'pause' | 'resume') => {
    await fetch(`/api/control/${action}`, { method: 'POST' });
  }, []);

  if (!snap) {
    return <div className="connecting">{connected ? 'Loading…' : 'Connecting to gum-bot…'}</div>;
  }

  const stale = Date.now() - lastAt > 5000;
  const running = !snap.runner.paused;
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Gum Bot
        </div>
        <span className="pill">
          <i className={`dot ${running && !stale ? 'live' : ''}`} style={{ background: stale ? 'var(--critical)' : running ? 'var(--good)' : 'var(--warning)' }} />
          {stale ? 'Disconnected' : running ? 'Running' : 'Paused'}
        </span>
        <div className="meta">
          <span>up {duration(snap.now - snap.startedAt)}</span>
          <span>
            {snap.config.moverCount} movers · {Number(snap.config.amount) / 10 ** snap.config.decimals} {snap.config.token} per deposit
          </span>
          <span className="mono" title={snap.config.funder}>
            funder {short(snap.config.funder)}
          </span>
          <span className="muted">updated {ago(lastAt)}</span>
        </div>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="Theme">
          {(
            [
              [null, 'Auto'],
              ['light', 'Light'],
              ['dark', 'Dark'],
            ] as const
          ).map(([v, label]) => (
            <button key={label} aria-pressed={theme === v} onClick={() => setTheme(v)}>
              {label}
            </button>
          ))}
        </div>
        {running ? (
          <button className="btn" onClick={() => control('pause')}>
            Pause
          </button>
        ) : (
          <button className="btn primary" onClick={() => control('resume')}>
            Resume
          </button>
        )}
      </header>

      {snap.alerts.length > 0 && (
        <div className="alerts" role="status">
          {snap.alerts.map((a) => (
            <div key={a.message} className={`alert ${a.level}`}>
              <span className="ico">{a.level === 'error' ? '■' : '▲'}</span>
              {a.message}
            </div>
          ))}
        </div>
      )}

      <KpiRow snap={snap} />

      <div className="grid g-2-1">
        <ThroughputChart snap={snap} />
        <CycleCard snap={snap} />
      </div>

      <div className="grid g-2-1">
        <LatencyCard snap={snap} />
        <GumCard snap={snap} />
      </div>

      <div className="section-title">Chains</div>
      <ChainCards snap={snap} />

      <MoverGrid snap={snap} onOpen={setMover} />

      <div className="section-title">Deposits &amp; events</div>
      <div className="grid g-2-1">
        <DepositsTable snap={snap} rows={snap.recentDeposits} onOpen={setDeposit} />
        <ActivityFeed items={activity} now={Date.now()} freshIds={fresh} />
      </div>
      <div className="grid g-2">
        <TopupsTable snap={snap} />
      </div>

      {mover !== null && (
        <MoverDrawer
          index={mover}
          snap={snap}
          onClose={() => setMover(null)}
          onOpenDeposit={(id) => {
            setMover(null);
            setDeposit(id);
          }}
        />
      )}
      {deposit && <DepositDrawer id={deposit} snap={snap} onClose={() => setDeposit(null)} />}
    </div>
  );
}
