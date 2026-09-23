import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateCap } from '../src/ratecap.ts';

const worstWindow = (times: number[], windowMs = 60_000) => {
  const ts = [...times].sort((a, b) => a - b);
  let worst = 0;
  for (let i = 0, j = 0; i < ts.length; i++) {
    while (ts[i]! - ts[j]! >= windowMs) j++;
    worst = Math.max(worst, i - j + 1);
  }
  return worst;
};

test('admits a burst up to the limit, then nothing until a slot is a full window past its response', () => {
  const cap = new RateCap(50, 60_000);
  const t0 = 1_000_000;
  const slots = Array.from({ length: 50 }, () => cap.record(t0));
  assert.equal(cap.available(t0 + 1), 0);
  assert.equal(cap.nextFreeAt(t0 + 1), t0 + 1_001); // all in flight: re-check in a second
  slots.forEach((s, i) => s.complete(t0 + 100 + i)); // responses arrive over 150 ms
  assert.equal(cap.nextFreeAt(t0 + 200), t0 + 60_100); // first slot frees a window after its response
  assert.equal(cap.available(t0 + 60_100), 1);
  assert.equal(cap.available(t0 + 60_150), 50);
});

test('Gum never sees more than the cap in any rolling minute, whatever the latency jitter', () => {
  for (let run = 0; run < 20; run++) {
    const cap = new RateCap(50, 60_000);
    const gumTimes: number[] = [];
    let now = 0;
    while (now < 600_000) {
      const n = Math.min(1 + Math.floor(Math.random() * 60), cap.available(now));
      for (let i = 0; i < n; i++) {
        const latency = Math.floor(Math.random() * 3_000); // up to 3 s per request
        const slot = cap.record(now);
        gumTimes.push(now + Math.floor(Math.random() * (latency + 1))); // Gum stamps somewhere in between
        slot.complete(now + latency);
      }
      now = n ? now + Math.floor(Math.random() * 5_000) : Math.max(cap.nextFreeAt(now), now + 1);
    }
    assert.ok(worstWindow(gumTimes) <= 50, `run ${run}: Gum saw ${worstWindow(gumTimes)} in a minute`);
    assert.ok(gumTimes.length >= 440, `run ${run}: budget should be used (got ${gumTimes.length} in 10 min)`);
  }
});

test('seeded from before a restart; 0 means no cap', () => {
  const now = 5_000_000;
  const cap = new RateCap(3, 60_000, [now - 50_000, now - 10_000, now - 70_000]);
  assert.equal(cap.used(now), 2);
  assert.equal(cap.available(now), 1);
  const none = new RateCap(0);
  assert.equal(none.enabled, false);
  assert.equal(none.available(), Number.POSITIVE_INFINITY);
});
