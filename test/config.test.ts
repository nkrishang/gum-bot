import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { loadConfig } from '../src/config.ts';

const KEY = `0x${'11'.repeat(32)}`;
const base = {
  GUM_API_KEY: 'gum_sk_test',
  FUNDER_PRIVATE_KEY: KEY,
  MOVER_MNEMONIC: 'test test test test test test test test test test test junk',
  RPC_URL_MONAD: 'http://m',
  RPC_URL_BASE: 'http://b',
  RPC_URL_ARBITRUM: 'http://a',
};

test('defaults: three chains, 50 movers, 1 USDC, round-robin rotation', () => {
  const c = loadConfig(base);
  assert.deepEqual(c.chains.map((x) => x.slug), ['monad', 'base', 'arbitrum']);
  assert.equal(c.movers.count, 50);
  assert.equal(c.deposit.amount, 1_000_000n);
  assert.equal(c.gum.apiUrl, 'https://api.gum.money');
  assert.deepEqual(c.moverChainRotation, ['monad', 'base', 'arbitrum']);
  assert.ok(c.gum.rateLimitRps <= 50);
});

test('per-chain gas thresholds and weighted rotation', () => {
  const c = loadConfig({ ...base, CHAINS: 'base,arbitrum', GAS_MIN_BASE: '0.001', GAS_TOPUP_BASE: '0.01', MOVER_CHAIN_ROTATION: 'base,base,arbitrum' });
  const b = c.chains.find((x) => x.slug === 'base')!;
  assert.equal(b.gasMin, '0.001');
  assert.equal(b.gasTopup, '0.01');
  assert.deepEqual(c.moverChainRotation, ['base', 'base', 'arbitrum']);
});

test('explicit mover keys set the mover count', () => {
  const c = loadConfig({ ...base, MOVER_MNEMONIC: '', MOVER_PRIVATE_KEYS: `${KEY.replace('11', '22')}, ${KEY.replace('11', '33')}` });
  assert.equal(c.movers.count, 2);
});

test('rejects what would break at runtime', () => {
  const bad = (env: Record<string, string>, re: RegExp) => assert.throws(() => loadConfig({ ...base, ...env }), re);
  bad({ RPC_URL_BASE: '' }, /RPC_URL_BASE is required/);
  bad({ CHAINS: 'solana' }, /unknown chain "solana"/);
  bad({ CHAINS: 'base', MOVER_CHAIN_ROTATION: 'monad' }, /is not in CHAINS/);
  bad({ DEPOSIT_AMOUNT: '1.5' }, /DEPOSIT_AMOUNT/);
  bad({ DEPOSIT_EXPIRY_SECS: '120' }, /at least 300s/);
  bad({ GUM_RATE_LIMIT_RPS: '80' }, /50\/s per key/);
  bad({ GAS_MIN_MONAD: 'lots' }, /GAS_MIN_MONAD/);
  bad({ MOVER_MNEMONIC: '' }, /MOVER_PRIVATE_KEYS/);
  bad({ GUM_WEBHOOK_SECRET: 'x' }, /PUBLIC_URL/);
  assert.throws(() => loadConfig({ ...base, GUM_API_KEY: '' }), /GUM_API_KEY/);
});

test('.env.example: the required block is exactly what is required, the rest are the real defaults', () => {
  const example = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
  // As shipped, every required value is blank, and one run reports all of them together.
  const err = (() => {
    try {
      loadConfig(example);
    } catch (e) {
      return (e as Error).message;
    }
  })();
  assert.ok(err, 'a blank .env.example must not start');
  for (const key of ['GUM_API_KEY', 'FUNDER_PRIVATE_KEY', 'MOVER_PRIVATE_KEYS or MOVER_MNEMONIC', 'RPC_URL_MONAD', 'RPC_URL_BASE', 'RPC_URL_ARBITRUM']) {
    assert.ok(err!.includes(key), `missing "${key}" in:\n${err}`);
  }
  assert.equal(err!.split('\n').length - 1, 6, `only the required block should be reported:\n${err}`);

  // With the required block filled in, the file configures exactly what an empty environment does:
  // every optional value it shows is the actual default.
  assert.deepEqual(loadConfig({ ...example, ...base }), loadConfig(base));
});
