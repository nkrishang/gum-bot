import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { Alerter } from '../src/alerts.ts';
import { Bot } from '../src/bot.ts';
import { loadConfig } from '../src/config.ts';
import { Db, type DepositRow } from '../src/db.ts';
import { GumClient } from '../src/gum.ts';
import { createLogger } from '../src/log.ts';

test('a stuck paid deposit alerts once, then resolves when it settles', async () => {
  const config = loadConfig({
    GUM_API_KEY: 'k', FUNDER_PRIVATE_KEY: `0x${'11'.repeat(32)}`, MOVER_PRIVATE_KEYS: `0x${'22'.repeat(32)}`,
    CHAINS: 'base', RPC_URL_BASE: 'http://127.0.0.1:1', ALERT_WEBHOOK_URL: 'https://hooks.example/x', ALERT_STUCK_SECS: '60',
  });
  const db = new Db(mkdtempSync(join(tmpdir(), 'gumbot-alerts-')));
  const bot = new Bot(config, db, new GumClient('http://x', 'k', 10, 10), createLogger('silent', false), privateKeyToAccount(config.funderKey), [privateKeyToAccount(config.movers.privateKeys![0]!)]);
  const runner = { paused: false, waiting: undefined } as never;
  const alerter = new Alerter(bot, runner, config.alerts.webhookUrl, config.alerts);
  const sent: string[] = [];
  (alerter as unknown as { send: (t: string) => Promise<void> }).send = async (t) => void sent.push(t);
  const evaluate = () => (alerter as unknown as { evaluate: () => void }).evaluate();

  const now = Date.now();
  const row = { id: 'd-stuck', chain: 'base', pay_status: 'mined', pay_mined_at: now - 120_000, status: 'paid', mover: 0, terminal: 0 } as DepositRow;
  bot.open.set(row.id, row);
  evaluate();
  evaluate(); // no repeat within the hour
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /1 paid deposit\(s\) not settled after 60s .*d-stuck/);

  bot.open.delete(row.id);
  evaluate();
  assert.equal(sent.length, 2);
  assert.match(sent[1]!, /^✅ resolved/);
});
