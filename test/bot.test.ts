import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { Bot } from '../src/bot.ts';
import { loadConfig } from '../src/config.ts';
import { Db, type DepositRow } from '../src/db.ts';
import { GumClient, type GumDeposit } from '../src/gum.ts';
import { createLogger } from '../src/log.ts';

function setup() {
  const config = loadConfig({
    GUM_API_KEY: 'k',
    FUNDER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    MOVER_PRIVATE_KEYS: `0x${'22'.repeat(32)},0x${'33'.repeat(32)}`,
    CHAINS: 'base',
    RPC_URL_BASE: 'http://127.0.0.1:1',
  });
  const db = new Db(mkdtempSync(join(tmpdir(), 'gumbot-')));
  const movers = config.movers.privateKeys!.map((k) => privateKeyToAccount(k));
  const terminal: string[] = [];
  const bot = new Bot(config, db, new GumClient('http://x', 'k', 10, 10), createLogger('silent', false), privateKeyToAccount(config.funderKey), movers, (r) => terminal.push(r.id));
  return { bot, db, terminal };
}

function openDeposit(bot: Bot, id: string, mover = 0): DepositRow {
  const now = Date.now();
  const row: DepositRow = {
    id, cycle: 1, mover, mover_address: bot.movers[mover]!.address, chain: 'base', payment_address: '0xpay', token_address: '0xusdc',
    amount: '1000000', status: 'pending', pay_status: 'mined', pay_tx: '0xtx', pay_error: null, pay_gas_cost: null, create_ms: 40,
    created_at: now - 10_000, gum_created_at: now - 10_000, expires_at: now + 600_000, pay_sent_at: now - 9_000, pay_mined_at: now - 8_000,
    detected_at: null, ready_at: null, settled_at: null, terminal_at: null, settle_tx: null, failure_code: null, failure_message: null,
    stages: null, webhooks: null, updated_at: now, terminal: 0,
  };
  bot.db.insertDeposit(row);
  bot.open.set(id, row);
  bot.movers[mover]!.activeDeposit = id;
  bot.movers[mover]!.phase = 'settling';
  return row;
}

const gum = (id: string, status: GumDeposit['status'], extra: Partial<GumDeposit['timestamps']> = {}, more: Partial<GumDeposit> = {}): GumDeposit => ({
  id, status, payment_address: '0xpay', chain_id: 8453, token: 'USDC', token_address: '0xusdc', token_decimals: 6, amount: '1000000',
  confirmed_amount: '0', receiver: '0x', recovery: '0x', salt: '0x', expires_at: new Date().toISOString(),
  timestamps: { created_at: new Date(Date.now() - 10_000).toISOString(), updated_at: new Date().toISOString(), ...extra },
  ...more,
});

test('settlement frees the mover, counts once, credits its balance and persists', () => {
  const { bot, db, terminal } = setup();
  openDeposit(bot, 'd1');
  bot.movers[0]!.balances.base = { native: 10n ** 16n, token: 0n, at: Date.now() - 5_000 };
  const detected = new Date(Date.now() - 7_000).toISOString();
  bot.applyGumDeposit(gum('d1', 'partial_paid', { detected_at: detected }), 'poll');
  assert.equal(bot.totals.detected, 1);
  bot.applyGumDeposit(gum('d1', 'paid', { detected_at: detected }), 'webhook');
  const settled = gum('d1', 'settled', { detected_at: detected, settled_at: new Date().toISOString() }, { tx_hash: '0xsettle' });
  bot.applyGumDeposit(settled, 'poll');
  bot.applyGumDeposit(settled, 'webhook'); // replay

  assert.equal(bot.totals.settled, 1);
  assert.equal(bot.totals.detected, 1);
  assert.equal(bot.totals.volumeSettled, '1000000');
  assert.equal(bot.open.size, 0);
  assert.equal(bot.movers[0]!.activeDeposit, undefined);
  assert.equal(bot.movers[0]!.phase, 'idle');
  assert.equal(bot.movers[0]!.balances.base!.token, 1_000_000n);
  assert.deepEqual(terminal, ['d1']);
  const row = db.getDeposit('d1')!;
  assert.equal(row.status, 'settled');
  assert.equal(row.terminal, 1);
  assert.equal(row.settle_tx, '0xsettle');
  assert.ok(row.ready_at);
});

test('a terminal status is never overwritten by a stale observation', () => {
  const { bot, db } = setup();
  openDeposit(bot, 'd2');
  bot.applyGumDeposit(gum('d2', 'failed', { failed_at: new Date().toISOString() }, { failure: { code: 'expired_on_chain', message: 'late' } }), 'poll');
  bot.applyGumDeposit(gum('d2', 'paid'), 'fetch');
  const row = db.getDeposit('d2')!;
  assert.equal(row.status, 'failed');
  assert.equal(row.failure_code, 'expired_on_chain');
  assert.equal(bot.totals.failed, 1);
  assert.equal(bot.recentActivity(5).some((a) => a.kind === 'deposit.failed'), true);
});

test('event timelines fetched after the fact are stored for the stage breakdown', () => {
  const { bot, db } = setup();
  openDeposit(bot, 'd3');
  bot.applyGumDeposit(gum('d3', 'settled', { settled_at: new Date().toISOString() }), 'poll');
  const t = new Date().toISOString();
  bot.applyGumDeposit(gum('d3', 'settled', {}, { events: [{ id: 'e', sequence: 1, type: 'deposit.ready', data: {}, created_at: t }] }), 'fetch');
  assert.deepEqual(JSON.parse(db.getDeposit('d3')!.stages!), { 'deposit.ready': Date.parse(t) });
});

test('unpaid expiries are told apart from paid ones; restarts resume open deposits', () => {
  const { bot, db } = setup();
  const row = openDeposit(bot, 'd4', 1);
  row.pay_status = 'failed';
  db.updateDeposit('d4', { pay_status: 'failed' });
  bot.applyGumDeposit(gum('d4', 'expired', { expired_at: new Date().toISOString() }), 'poll');
  assert.equal(bot.totals.expired, 1);
  assert.equal(bot.totals.expiredUnpaid, 1);

  openDeposit(bot, 'd5', 0);
  const again = new Bot(bot.config, db, bot.gum, bot.log, bot.funder, bot.movers.map((m) => m.account));
  again.restoreOpenDeposits();
  assert.equal(again.open.has('d5'), true);
  assert.equal(again.movers[0]!.activeDeposit, 'd5');
});

test('mover chain resolution prefers the rotation, falls back to wherever the USDC is', () => {
  const { bot } = setup();
  const mv = bot.movers[0]!;
  assert.equal(bot.resolveMoverChain(mv), undefined);
  mv.balances.base = { native: 1n, token: 1_000_000n, at: Date.now() };
  assert.equal(bot.resolveMoverChain(mv), 'base');
  mv.balances.base = { native: 0n, token: 1_000_000n, at: Date.now() };
  assert.equal(bot.resolveMoverChain(mv), undefined);
  assert.equal(bot.moverHealth(mv), 'no_gas');
});
