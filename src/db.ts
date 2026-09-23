import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/**
 * Local history so the dashboard survives restarts and deploys: every deposit the bot created, its
 * on-chain payment, its Gum timeline, cycles, gas top-ups and the activity feed. SQLite in WAL mode on
 * a Railway volume; all writes are small and synchronous.
 */

export interface DepositRow {
  id: string;
  cycle: number;
  mover: number;
  mover_address: string;
  chain: string;
  payment_address: string;
  token_address: string;
  amount: string;
  status: string;
  pay_status: 'pending' | 'sent' | 'mined' | 'failed' | 'skipped';
  pay_tx: string | null;
  pay_error: string | null;
  pay_gas_cost: string | null;
  create_ms: number | null;
  created_at: number;
  gum_created_at: number | null;
  expires_at: number;
  pay_sent_at: number | null;
  pay_mined_at: number | null;
  detected_at: number | null;
  ready_at: number | null;
  settled_at: number | null;
  terminal_at: number | null;
  settle_tx: string | null;
  failure_code: string | null;
  failure_message: string | null;
  stages: string | null;
  webhooks: string | null;
  updated_at: number;
  terminal: number;
}

export interface TopupRow {
  id: number;
  chain: string;
  mover: number;
  address: string;
  amount: string;
  tx: string | null;
  status: 'sent' | 'mined' | 'failed';
  error: string | null;
  created_at: number;
  mined_at: number | null;
}

export interface CycleRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  planned: number;
  created: number;
  paid: number;
  settled: number;
  failed: number;
  carried: number;
  errors: number;
}

export interface ActivityRow {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  data: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  cycle INTEGER NOT NULL,
  mover INTEGER NOT NULL,
  mover_address TEXT NOT NULL,
  chain TEXT NOT NULL,
  payment_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL,
  pay_status TEXT NOT NULL DEFAULT 'pending',
  pay_tx TEXT, pay_error TEXT, pay_gas_cost TEXT,
  create_ms INTEGER,
  created_at INTEGER NOT NULL,
  gum_created_at INTEGER,
  expires_at INTEGER NOT NULL,
  pay_sent_at INTEGER, pay_mined_at INTEGER,
  detected_at INTEGER, ready_at INTEGER, settled_at INTEGER, terminal_at INTEGER,
  settle_tx TEXT, failure_code TEXT, failure_message TEXT,
  stages TEXT, webhooks TEXT,
  updated_at INTEGER NOT NULL,
  terminal INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS deposits_open ON deposits (terminal) WHERE terminal = 0;
CREATE INDEX IF NOT EXISTS deposits_created ON deposits (created_at);
CREATE INDEX IF NOT EXISTS deposits_terminal_at ON deposits (terminal_at);
CREATE INDEX IF NOT EXISTS deposits_mover ON deposits (mover, created_at);

CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  planned INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  settled INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  carried INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS topups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  mover INTEGER NOT NULL,
  address TEXT NOT NULL,
  amount TEXT NOT NULL,
  tx TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  mined_at INTEGER
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class Db {
  readonly sql: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.sql = new DatabaseSync(join(dataDir, 'gum-bot.db'));
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.sql.exec(SCHEMA);
  }

  close() {
    this.sql.close();
  }

  // ---- kv -----------------------------------------------------------------------------------

  getKv<T>(key: string): T | undefined {
    const row = this.sql.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setKv(key: string, value: unknown) {
    this.sql
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  // ---- deposits -----------------------------------------------------------------------------

  insertDeposit(row: DepositRow) {
    const cols = Object.keys(row);
    this.sql
      .prepare(
        `INSERT INTO deposits (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT (id) DO NOTHING`,
      )
      .run(...(Object.values(row) as SQLInputValue[]));
  }

  updateDeposit(id: string, patch: Partial<DepositRow>) {
    const entries = Object.entries({ ...patch, updated_at: Date.now() });
    this.sql
      .prepare(`UPDATE deposits SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...(entries.map(([, v]) => v ?? null) as SQLInputValue[]), id);
  }

  openDeposits(): DepositRow[] {
    return this.sql.prepare('SELECT * FROM deposits WHERE terminal = 0 ORDER BY created_at').all() as unknown as DepositRow[];
  }

  recentDeposits(limit: number, filter: { mover?: number; chain?: string; status?: string } = {}): DepositRow[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.mover !== undefined) (where.push('mover = ?'), args.push(filter.mover));
    if (filter.chain) (where.push('chain = ?'), args.push(filter.chain));
    if (filter.status) (where.push('status = ?'), args.push(filter.status));
    return this.sql
      .prepare(
        `SELECT * FROM deposits ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...args, limit) as unknown as DepositRow[];
  }

  /** Creation times since `since`, oldest first (seeds the deposit rate cap after a restart). */
  createdSince(since: number): number[] {
    return (this.sql.prepare('SELECT created_at FROM deposits WHERE created_at > ? ORDER BY created_at').all(since) as Array<{ created_at: number }>).map((r) => r.created_at);
  }

  getDeposit(id: string): DepositRow | undefined {
    return this.sql.prepare('SELECT * FROM deposits WHERE id = ?').get(id) as unknown as DepositRow | undefined;
  }

  /** Deposits that reached a terminal state since `since`, for latency percentiles. */
  terminalSince(since: number, limit = 2000): DepositRow[] {
    return this.sql
      .prepare('SELECT * FROM deposits WHERE terminal = 1 AND terminal_at >= ? ORDER BY terminal_at DESC LIMIT ?')
      .all(since, limit) as unknown as DepositRow[];
  }

  /** Per-minute counts for the throughput chart. */
  minuteBuckets(since: number): Array<{ minute: number; chain: string; created: number; settled: number; failed: number }> {
    const created = this.sql
      .prepare(
        `SELECT created_at / 60000 AS minute, chain, COUNT(*) AS n FROM deposits WHERE created_at >= ? GROUP BY 1, 2`,
      )
      .all(since) as Array<{ minute: number; chain: string; n: number }>;
    const done = this.sql
      .prepare(
        `SELECT terminal_at / 60000 AS minute, chain, status, COUNT(*) AS n FROM deposits
         WHERE terminal = 1 AND terminal_at >= ? GROUP BY 1, 2, 3`,
      )
      .all(since) as Array<{ minute: number; chain: string; status: string; n: number }>;
    const map = new Map<string, { minute: number; chain: string; created: number; settled: number; failed: number }>();
    const at = (minute: number, chain: string) => {
      const k = `${minute}:${chain}`;
      let v = map.get(k);
      if (!v) map.set(k, (v = { minute, chain, created: 0, settled: 0, failed: 0 }));
      return v;
    };
    for (const r of created) at(r.minute, r.chain).created += r.n;
    for (const r of done) {
      if (r.status === 'settled') at(r.minute, r.chain).settled += r.n;
      else at(r.minute, r.chain).failed += r.n;
    }
    return [...map.values()];
  }

  // ---- cycles -------------------------------------------------------------------------------

  upsertCycle(c: CycleRow) {
    this.sql
      .prepare(
        `INSERT INTO cycles (id, started_at, ended_at, planned, created, paid, settled, failed, carried, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET ended_at = excluded.ended_at, planned = excluded.planned,
           created = excluded.created, paid = excluded.paid, settled = excluded.settled,
           failed = excluded.failed, carried = excluded.carried, errors = excluded.errors`,
      )
      .run(c.id, c.started_at, c.ended_at, c.planned, c.created, c.paid, c.settled, c.failed, c.carried, c.errors);
  }

  recentCycles(limit: number): CycleRow[] {
    return this.sql.prepare('SELECT * FROM cycles ORDER BY id DESC LIMIT ?').all(limit) as unknown as CycleRow[];
  }

  lastCycleId(): number {
    const row = this.sql.prepare('SELECT MAX(id) AS id FROM cycles').get() as { id: number | null };
    return row.id ?? 0;
  }

  // ---- top-ups ------------------------------------------------------------------------------

  insertTopup(t: Omit<TopupRow, 'id'>): number {
    const r = this.sql
      .prepare(
        'INSERT INTO topups (chain, mover, address, amount, tx, status, error, created_at, mined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(t.chain, t.mover, t.address, t.amount, t.tx, t.status, t.error, t.created_at, t.mined_at);
    return Number(r.lastInsertRowid);
  }

  updateTopup(id: number, patch: Partial<TopupRow>) {
    const entries = Object.entries(patch);
    this.sql
      .prepare(`UPDATE topups SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...(entries.map(([, v]) => v ?? null) as SQLInputValue[]), id);
  }

  recentTopups(limit: number): TopupRow[] {
    return this.sql.prepare('SELECT * FROM topups ORDER BY id DESC LIMIT ?').all(limit) as unknown as TopupRow[];
  }

  // ---- activity -----------------------------------------------------------------------------

  insertActivity(a: Omit<ActivityRow, 'id'>): number {
    const r = this.sql
      .prepare('INSERT INTO activity (ts, level, kind, message, data) VALUES (?, ?, ?, ?, ?)')
      .run(a.ts, a.level, a.kind, a.message, a.data);
    return Number(r.lastInsertRowid);
  }

  recentActivity(limit: number): ActivityRow[] {
    return this.sql.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit) as unknown as ActivityRow[];
  }

  /** Drops history older than the retention window. Open deposits are always kept. */
  prune(retainDays: number) {
    const cutoff = Date.now() - retainDays * 86_400_000;
    this.sql.prepare('DELETE FROM deposits WHERE terminal = 1 AND created_at < ?').run(cutoff);
    this.sql.prepare('DELETE FROM cycles WHERE started_at < ?').run(cutoff);
    this.sql.prepare('DELETE FROM topups WHERE created_at < ?').run(cutoff);
    this.sql.prepare('DELETE FROM activity WHERE ts < ?').run(cutoff);
  }
}
