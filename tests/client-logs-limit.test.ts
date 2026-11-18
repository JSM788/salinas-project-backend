import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FixedWindowLimiter } from '../src/common/http/fixed-window-limiter';
import { clientLogInputSchema } from '../src/modules/platform/dto/platform.dto';

test('limiter blocks after the limit, keeps keys independent and resets after the window', () => {
  let clock = 1_000;
  const limiter = new FixedWindowLimiter(2, 1_000, 100, () => clock);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), false);
  assert.equal(limiter.allow('b'), true);
  clock += 1_000;
  assert.equal(limiter.allow('a'), true);
});

test('limiter bounds tracked keys and frees expired ones before refusing', () => {
  let clock = 0;
  const limiter = new FixedWindowLimiter(5, 1_000, 2, () => clock);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('b'), true);
  assert.equal(limiter.allow('c'), false);
  clock += 1_000;
  assert.equal(limiter.allow('c'), true);
});

test('client log schema accepts small details and rejects oversized or unknown fields', () => {
  const base = { source: 'mobile', event: 'login', message: 'ok' };
  assert.equal(clientLogInputSchema.safeParse({ ...base, details: { a: 1 } }).success, true);
  assert.equal(clientLogInputSchema.safeParse({ ...base, details: { blob: 'x'.repeat(5000) } }).success, false);
  assert.equal(clientLogInputSchema.safeParse({ ...base, extra: true }).success, false);
  assert.equal(clientLogInputSchema.safeParse(base).success, true);
});
