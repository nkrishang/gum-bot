import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { streamSSE } from 'hono/streaming';
import type { Bot } from './bot.ts';
import type { GumDeposit } from './gum.ts';
import { m, registry } from './metrics.ts';
import type { Runner } from './runner.ts';
import { depositView, type SnapshotBuilder } from './snapshot.ts';
import type { Treasury } from './treasury.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export function createApp(opts: {
  bot: Bot;
  runner: Runner;
  treasury: Treasury;
  snapshots: SnapshotBuilder;
  webDir: string;
  isReady: () => boolean;
}) {
  const { bot, runner, treasury, snapshots, webDir } = opts;
  const cfg = bot.config;
  const app = new Hono();

  // Everything but health, metrics (own token) and webhooks (HMAC) sits behind basic auth.
  if (cfg.server.dashboardPassword) {
    const auth = basicAuth({ username: cfg.server.dashboardUser, password: cfg.server.dashboardPassword });
    const open = new Set(['/healthz', '/readyz', '/metrics', '/webhooks/gum']);
    app.use('*', (c, next) => (open.has(c.req.path) ? next() : auth(c, next)));
  }

  // ---- unauthenticated ------------------------------------------------------------------------

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', (c) => {
    const chains = Object.fromEntries([...bot.chainHealth].map(([slug, h]) => [slug, h.rpcOk]));
    const ok = opts.isReady() && Object.values(chains).some(Boolean);
    return c.json({ status: ok ? 'ok' : 'starting', chains }, ok ? 200 : 503);
  });

  app.get('/metrics', async (c) => {
    if (cfg.server.metricsToken && c.req.header('authorization') !== `Bearer ${cfg.server.metricsToken}`) {
      return c.text('unauthorized', 401);
    }
    return c.text(await registry.metrics(), 200, { 'content-type': registry.contentType });
  });

  // Gum app webhooks, authenticated by their HMAC signature (same scheme as gum-server's).
  app.post('/webhooks/gum', async (c) => {
    const secret = cfg.gum.webhookSecret;
    if (!secret) return c.json({ error: 'webhooks not configured' }, 404);
    const raw = await c.req.text();
    if (!verifySignature(secret, c.req.header('x-gum-signature') ?? '', raw, 300)) {
      m.webhooks.inc({ type: c.req.header('x-gum-event-type') ?? 'unknown', outcome: 'bad_signature' });
      return c.json({ error: 'bad signature' }, 401);
    }
    let body: { id: string; type: string; created_at: string; deposit: GumDeposit };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'bad json' }, 400);
    }
    const receivedAt = Date.now();
    const lagMs = Math.max(receivedAt - Date.parse(body.created_at), 0);
    m.webhooks.inc({ type: body.type, outcome: 'ok' });
    m.webhookLag.observe({ type: body.type }, lagMs / 1000);
    bot.bump('_', 'webhooks');
    const row = bot.open.get(body.deposit.id) ?? bot.db.getDeposit(body.deposit.id);
    if (row) {
      const hooks = row.webhooks ? (JSON.parse(row.webhooks) as Record<string, unknown>) : {};
      if (!(body.type in hooks)) {
        hooks[body.type] = { receivedAt, lagMs };
        row.webhooks = JSON.stringify(hooks);
        bot.db.updateDeposit(row.id, { webhooks: row.webhooks });
      }
      bot.applyGumDeposit(body.deposit, 'webhook');
    }
    return c.json({ ok: true });
  });

  // ---- operator (dashboard + API) -------------------------------------------------------------

  app.get('/api/snapshot', (c) => c.json(snapshots.build()));

  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      const onActivity = (row: unknown) => {
        void stream.writeSSE({ event: 'activity', data: JSON.stringify(row) }).catch(() => (open = false));
      };
      bot.on('activity', onActivity);
      try {
        while (open) {
          await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshots.build()) });
          await stream.sleep(1000);
        }
      } finally {
        bot.off('activity', onActivity);
      }
    }),
  );

  app.get('/api/deposits', (c) => {
    const q = c.req.query();
    const rows = bot.db.recentDeposits(Math.min(Number(q.limit ?? 100), 1000), {
      mover: q.mover !== undefined ? Number(q.mover) : undefined,
      chain: q.chain,
      status: q.status,
    });
    return c.json({ items: rows.map(depositView) });
  });

  app.get('/api/deposits/:id', async (c) => {
    const row = bot.db.getDeposit(c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    // Live view straight from Gum, including the full event timeline.
    let gum: GumDeposit | { error: string };
    try {
      gum = await bot.gum.getDeposit(row.id);
    } catch (err) {
      gum = { error: (err as Error).message };
    }
    return c.json({ deposit: depositView(row), gum });
  });

  app.get('/api/movers/:index', (c) => {
    const index = Number(c.req.param('index'));
    const mv = bot.movers[index];
    if (!mv) return c.json({ error: 'not found' }, 404);
    const balances = Object.fromEntries(
      Object.entries(mv.balances).map(([slug, b]) => [
        slug,
        { native: b?.native?.toString() ?? null, token: b?.token?.toString() ?? null, at: b?.at ?? null },
      ]),
    );
    return c.json({
      index,
      address: mv.address,
      balances,
      deposits: bot.db.recentDeposits(50, { mover: index }).map(depositView),
      topups: bot.db.recentTopups(500).filter((t) => t.mover === index).slice(0, 20),
    });
  });

  app.post('/api/control/pause', (c) => {
    runner.setPaused(true);
    return c.json({ paused: true });
  });
  app.post('/api/control/resume', (c) => {
    runner.setPaused(false);
    return c.json({ paused: false });
  });
  app.post('/api/movers/:index/:action{enable|disable}', (c) => {
    const ok = bot.setMoverEnabled(Number(c.req.param('index')), c.req.param('action') === 'enable');
    return ok ? c.json({ ok }) : c.json({ error: 'not found' }, 404);
  });
  app.post('/api/movers/:index/topup', (c) => {
    const mv = bot.movers[Number(c.req.param('index'))];
    if (!mv) return c.json({ error: 'not found' }, 404);
    const queued = treasury.requestTopup(mv, mv.chain);
    if (queued) bot.activity('info', 'control', `manual top-up requested for mover #${mv.index} on ${mv.chain}`);
    return c.json({ queued });
  });
  app.post('/api/balances/refresh', async (c) => {
    await treasury.refreshAll();
    return c.json({ ok: true });
  });

  // ---- dashboard static files -----------------------------------------------------------------

  app.get('*', async (c) => {
    if (!existsSync(webDir)) {
      return c.text('dashboard not built: run `pnpm build:web` (or `pnpm dev:web` for hot reload)', 503);
    }
    const path = normalize(c.req.path).replace(/^(\.\.[/\\])+/, '');
    let file = join(webDir, path);
    if (!file.startsWith(webDir) || !extname(file) || !existsSync(file)) file = join(webDir, 'index.html');
    const body = await readFile(file);
    const immutable = file.includes(`${join(webDir, 'assets')}`);
    return c.body(body, 200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  });

  return app;
}

export function verifySignature(secret: string, header: string, body: string, toleranceSecs: number, now = Date.now()): boolean {
  let t: number | undefined;
  let v1: string | undefined;
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't') t = Number(v);
    if (k === 'v1') v1 = v;
  }
  if (!t || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false;
  if (Math.abs(now / 1000 - t) > toleranceSecs) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  const got = Buffer.from(v1, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}
