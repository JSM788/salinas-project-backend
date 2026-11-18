import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, createTestDatabase, migrate, provision } from './support';
import { loadPolicy } from '../src/config/environment';

const PASSWORD = 'long-test-password';

test('login lockout does not extend while blocked and resets after expiry', async () => {
  const db = await createTestDatabase();
  try {
    await migrate(db);
    const policy = loadPolicy();
    await provision(db, 'lockout-co', 'Lockout', 'lock@example.test', PASSWORD);
    const identity = createIdentity(db);
    const attempt = (password: string, email = 'lock@example.test') =>
      identity.login({ company: 'lockout-co', email, password });
    const state = () => db.prisma.user.findUniqueOrThrow({ where: { email: 'lock@example.test' } });
    const rejected = (password: string, email?: string) =>
      assert.rejects(attempt(password, email), (error: any) => {
        assert.equal(error.code ?? error.response?.code ?? error.message, 'invalid_credentials');
        return true;
      });

    // Unchanged behavior: unknown account and successful login.
    await rejected('whatever-password', 'ghost@example.test');
    assert.ok((await attempt(PASSWORD)).token);
    assert.equal((await state()).failures, 0);

    // (a) N failures block the account.
    for (let i = 0; i < policy.LOGIN_MAX_FAILURES; i++) await rejected('wrong-password-value');
    const blocked = await state();
    assert.equal(blocked.failures, policy.LOGIN_MAX_FAILURES);
    assert.ok(blocked.blockedUntil && blocked.blockedUntil > new Date());

    // (b) attempts during the block change neither failures nor blockedUntil.
    await rejected('wrong-password-value');
    await rejected('wrong-password-value');
    // (c) correct password during the block is still rejected and changes nothing.
    await rejected(PASSWORD);
    const during = await state();
    assert.equal(during.failures, blocked.failures);
    assert.equal(during.blockedUntil?.getTime(), blocked.blockedUntil?.getTime());

    // (d) after expiry a failure restarts the count at 1 and clears blockedUntil.
    await db.prisma.user.update({ where: { id: blocked.id }, data: { blockedUntil: new Date(Date.now() - 1000) } });
    await rejected('wrong-password-value');
    const reset = await state();
    assert.equal(reset.failures, 1);
    assert.equal(reset.blockedUntil, null);

    // login_failed events are still recorded for real failures.
    const events = await db.prisma.accessEvent.count({ where: { userId: blocked.id, event: 'login_failed' } });
    assert.ok(events >= policy.LOGIN_MAX_FAILURES + 1);

    // (e) a correct login resets the counter.
    assert.ok((await attempt(PASSWORD)).token);
    const ok = await state();
    assert.equal(ok.failures, 0);
    assert.equal(ok.blockedUntil, null);
  } finally {
    await db.close();
  }
});
