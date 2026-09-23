import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { getAddress } from 'viem';
import { Alerter } from './alerts.ts';
import { Bot } from './bot.ts';
import { createChainRuntime } from './chains.ts';
import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import { GumClient, sleep, type GumChain } from './gum.ts';
import { loadWallets } from './keys.ts';
import { createLogger } from './log.ts';
import { m } from './metrics.ts';
import { Runner } from './runner.ts';
import { createApp } from './server.ts';
import { SnapshotBuilder } from './snapshot.ts';
import { Tracker } from './tracker.ts';
import { Treasury } from './treasury.ts';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadConfig();
  const log = createLogger(config.log.level, config.log.pretty);
  const { funder, movers } = loadWallets(config);
  const db = new Db(resolve(config.dataDir));
  const gum = new GumClient(config.gum.apiUrl, config.gum.apiKey, config.gum.rateLimitRps, config.gum.rateLimitBurst);

  log.info(
    { api: config.gum.apiUrl, funder: funder.address, movers: movers.length, chains: config.chains.map((c) => c.slug) },
    'starting gum-bot',
  );

  // Gum's registry tells us its PaymentFactory, used to verify payment addresses before paying.
  const gumChains = await resolveGumChains(gum, log);

  let tracker: Tracker | undefined;
  const bot = new Bot(config, db, gum, log, funder, movers, (row) => tracker?.enqueueEvents(row.id));
  gum.onRequest((op, status, ms) => bot.recordGumRequest(op, status, ms));

  for (const cc of config.chains) {
    const rt = createChainRuntime(cc);
    bot.addChain(rt);
    const remote = gumChains.find((g) => g.name === cc.slug);
    if (remote?.factory) bot.factory = getAddress(remote.factory);
    // Every deposit is refused if Gum's USDC is not Circle's; say why up front.
    const gumUsdc = remote?.tokens.find((t) => t.symbol === 'USDC')?.address;
    if (!gumUsdc || getAddress(gumUsdc) !== rt.token.address) {
      log.error({ chain: cc.slug, ours: rt.token.address, gums: gumUsdc ?? null }, 'Gum does not list the same USDC; deposits on this chain will be refused');
    }
  }

  // Payment addresses are checked against the on-chain factory wherever it is deployed.
  if (bot.factory) {
    await Promise.all(
      [...bot.chains.values()].map(async (c) => {
        try {
          const code = await c.public.getCode({ address: bot.factory! });
          if (code && code !== '0x') bot.verifyChains.add(c.slug);
          else log.warn({ chain: c.slug, factory: bot.factory }, 'factory has no code; payment addresses will not be verified');
        } catch (err) {
          log.warn({ chain: c.slug, err: (err as Error).message }, 'could not check factory code');
        }
      }),
    );
  }

  bot.restoreOpenDeposits();
  await refuseIfAnotherInstanceIsActive(bot, log);
  const treasury = new Treasury(bot);
  tracker = new Tracker(bot);
  const runner = new Runner(bot, treasury, tracker);
  const snapshots = new SnapshotBuilder(bot, runner, treasury);

  let ready = false;
  const app = createApp({ bot, runner, treasury, snapshots, webDir: resolveWebDir(), isReady: () => ready });
  const server = serve({ fetch: app.fetch, port: config.server.port, hostname: '::' }, (info) =>
    log.info({ port: info.port }, `dashboard on http://localhost:${info.port}`),
  );

  await treasury.start();
  tracker.start();
  runner.start();
  const alerter = new Alerter(bot, runner, config.alerts.webhookUrl, config.alerts);
  alerter.start();
  ready = true;
  bot.activity('info', 'boot', `gum-bot started with ${movers.length} movers on ${config.chains.map((c) => c.slug).join(', ')}${runner.paused ? ' (paused)' : ''}`);

  const housekeeping = setInterval(() => {
    bot.persistCounters();
    const perChain: Record<string, number> = {};
    for (const r of bot.open.values()) perChain[r.chain] = (perChain[r.chain] ?? 0) + 1;
    for (const slug of bot.chains.keys()) m.openDeposits.set({ chain: slug }, perChain[slug] ?? 0);
    treasury.updateHealthGauges();
  }, 5_000);
  const pruner = setInterval(() => db.prune(config.retainDays), 6 * 3_600_000);
  db.prune(config.retainDays);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down: finishing in-flight payments');
    clearInterval(housekeeping);
    clearInterval(pruner);
    alerter.stop();
    treasury.stop();
    tracker!.stop();
    // In-flight transfers get a grace period to be recorded; open deposits resume on the next boot.
    await Promise.race([runner.stop(), sleep(20_000)]);
    bot.persistCounters();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

async function resolveGumChains(gum: GumClient, log: ReturnType<typeof createLogger>): Promise<GumChain[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await gum.chains();
    } catch (err) {
      log.error({ err: (err as Error).message, attempt }, 'GET /v1/chains failed; retrying');
      await sleep(Math.min(1000 * attempt, 10_000));
    }
  }
}

/**
 * Two bots sharing the same mover keys would fight over nonces and USDC. If Gum shows deposits to our
 * movers created in the last two minutes that this instance never created, whatever their status,
 * another instance is running (e.g. a local run while the Railway service is up): refuse to start.
 */
async function refuseIfAnotherInstanceIsActive(bot: Bot, log: ReturnType<typeof createLogger>) {
  const movers = new Set(bot.movers.map((mv) => mv.address.toLowerCase()));
  const since = new Date(Date.now() - 120_000).toISOString();
  const foreign: string[] = [];
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await bot.gum.listDeposits({ created_after: since, limit: 200, cursor });
      for (const d of res.items) {
        if (movers.has(d.receiver.toLowerCase()) && !bot.db.getDeposit(d.id)) foreign.push(d.id);
      }
      cursor = res.next_cursor;
      if (!cursor) break;
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'could not check for another running instance; continuing');
    return;
  }
  if (foreign.length) {
    throw new Error(
      `another gum-bot instance appears to be running with these mover keys: Gum shows ${foreign.length} deposit(s) ` +
        `to our movers created in the last 2 minutes that this instance did not create (e.g. ${foreign[0]}). ` +
        'Stop the other instance (local or Railway), wait 2 minutes, and start this one again.',
    );
  }
}

function resolveWebDir() {
  // The built dashboard lives in dist/web: ../dist/web from src/ (tsx), ../web from dist/src/.
  const candidates = [resolve(here, '../dist/web'), resolve(here, '../web')];
  return candidates.find((d) => d.endsWith(join('dist', 'web')) && existsSync(join(d, 'index.html'))) ?? candidates[0]!;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
