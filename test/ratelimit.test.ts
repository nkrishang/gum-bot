import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenBucket } from '../src/ratelimit.ts';

test('admits the burst immediately, then paces at the rate', async () => {
  const bucket = new TokenBucket(20, 10);
  const t0 = performance.now();
  await Promise.all(Array.from({ length: 10 }, () => bucket.take()));
  assert.ok(performance.now() - t0 < 30, 'burst should not wait');
  const t1 = performance.now();
  await Promise.all(Array.from({ length: 10 }, () => bucket.take()));
  const waited = performance.now() - t1;
  // 10 more at 20/s ≈ 500ms.
  assert.ok(waited > 400 && waited < 800, `waited ${waited}ms`);
});

test('tryTake refuses once empty; penalize drains the bucket', () => {
  const bucket = new TokenBucket(1, 2);
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), false);
  const b2 = new TokenBucket(100, 100);
  b2.penalize(1000);
  assert.equal(b2.tryTake(), false);
});

test('never exceeds Gum limits under the default client settings', async () => {
  // The bot's defaults (40/s, burst 60) against Gum's bucket (50/s, burst 100): 200 requests fired at once.
  const client = new TokenBucket(40, 60);
  const server = new TokenBucket(50, 100);
  let refused = 0;
  await Promise.all(
    Array.from({ length: 200 }, async () => {
      await client.take();
      if (!server.tryTake()) refused++;
    }),
  );
  assert.equal(refused, 0);
});
