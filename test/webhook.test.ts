import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { verifySignature } from '../src/server.ts';

const sign = (secret: string, t: number, body: string) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('accepts gum-server signatures and rejects tampering, wrong secrets and stale timestamps', () => {
  const now = Date.now();
  const t = Math.floor(now / 1000);
  const body = '{"type":"deposit.settled"}';
  assert.equal(verifySignature('s3cret', sign('s3cret', t, body), body, 300, now), true);
  assert.equal(verifySignature('s3cret', sign('s3cret', t, body), body.replace('settled', 'failed'), 300, now), false);
  assert.equal(verifySignature('s3cret', sign('other', t, body), body, 300, now), false);
  assert.equal(verifySignature('s3cret', sign('s3cret', t - 600, body), body, 300, now), false);
  assert.equal(verifySignature('s3cret', 'garbage', body, 300, now), false);
  assert.equal(verifySignature('s3cret', `t=${t},v1=zz`, body, 300, now), false);
});
