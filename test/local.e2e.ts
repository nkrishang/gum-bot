/**
 * End to end against the local stack: three Anvil chains, the real PaymentFactory, the mock Gum API
 * with injected settlement failures, and the bot as a separate process. Asserts that deposits flow,
 * top-ups happen, and that the bot's books agree exactly with Gum's.
 *
 *   pnpm test:e2e        (needs Foundry's anvil on PATH)
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const hasAnvil = spawnSync('anvil', ['--version']).status === 0;
const PORT = 18080;
const GUM = 18090;

test('the bot runs the full loop against local chains and agrees with Gum', { skip: !hasAnvil && 'anvil not installed', timeout: 180_000 }, async () => {
  const proc = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'dev/local.ts', '--movers', '9', '--fail-rate', '0.1', '--port', String(PORT), '--gum-port', String(GUM), '--rpc-port', '18545', '--data-dir', mkdtempSync(join(tmpdir(), 'gumbot-e2e-'))],
    { cwd: join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  try {
    const snap = await waitFor(async () => {
      const s = await fetch(`http://127.0.0.1:${PORT}/api/snapshot`).then((r) => r.json()).catch(() => null);
      return s && s.totals.settled >= 18 && s.totals.cycles >= 3 ? s : null;
    }, 150_000, () => output);

    assert.equal(snap.movers.length, 9);
    assert.ok(snap.totals.topups >= 9, 'every mover started without gas and was topped up');
    assert.equal(snap.totals.createErrors, 0);
    assert.equal(snap.totals.addressMismatch, 0, 'every payment address matched the on-chain factory');

    // Let in-flight deposits settle so both sides are quiescent, then reconcile.
    await fetch(`http://127.0.0.1:${PORT}/api/control/pause`, { method: 'POST' });
    const settledSnap = await waitFor(async () => {
      const s = await fetch(`http://127.0.0.1:${PORT}/api/snapshot`).then((r) => r.json());
      return s.open === 0 ? s : null;
    }, 60_000, () => output);
    const gum = await fetch(`http://127.0.0.1:${GUM}/mock/stats`).then((r) => r.json());
    assert.equal(settledSnap.totals.created, gum.created, 'created');
    assert.equal(settledSnap.totals.settled, gum.settled, 'settled');
    assert.equal(settledSnap.totals.failed, gum.failed, 'failed');
    assert.equal(gum.rateLimited, 0, 'the bot never hit the rate limit');

    // A failed settlement strands that mover's USDC; the dashboard must say so.
    const noToken = settledSnap.movers.filter((m: { health: string }) => m.health === 'no_token').length;
    assert.equal(noToken, gum.failed);
    const metrics = await fetch(`http://127.0.0.1:${PORT}/metrics`).then((r) => r.text());
    assert.match(metrics, /gumbot_deposits_created_total\{chain="base"\} \d+/);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.once('exit', r));
  }
});

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, log: () => string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out; output:\n${log().slice(-4000)}`);
}
