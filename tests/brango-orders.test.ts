import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createTestDatabase, migrate, provision } from './support';
import { createApp } from '../src/app';
import { OperatorService } from '../src/modules/identity/services/operator.service';
import { CredentialsService } from '../src/modules/identity/services/credentials.service';

test('brango webhook authenticates with api key and hmac, matches multi-country phones, handles pending links, and scopes mobile orders', async () => {
  const db = await createTestDatabase();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await migrate(db);
    const manager = await provision(
      db,
      'aquamundo-brango',
      'Aquamundo',
      'manager@brango.test',
      'long-test-password',
      'America/Lima',
    );
    await db.prisma.membership.update({
      where: { id: manager.membershipId },
      data: { role: 'manager' },
    });

    const operator = new OperatorService(db.prisma, new CredentialsService());
    const commercialPeru = await operator.addMember(
      manager.companyId,
      'peru@brango.test',
      'long-test-password',
      'commercial',
    );
    await db.prisma.user.update({
      where: { id: commercialPeru.userId },
      data: { phone: '+51968995490', displayName: 'Ana Peru' },
    });

    const commercialEcuador = await operator.addMember(
      manager.companyId,
      'ecuador@brango.test',
      'long-test-password',
      'commercial',
    );
    await db.prisma.user.update({
      where: { id: commercialEcuador.userId },
      data: { phone: '+593991234567', displayName: 'Carlos Ecuador' },
    });

    app = await createApp(db.prisma, false, [], [
      { host: 'brango.example', company: 'aquamundo-brango' },
    ]);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();

    const login = async (email: string, web: boolean) => {
      const res = await fetch(
        base + (web ? '/v1/auth/web/login' : '/v1/auth/login'),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-Host': 'brango.example',
          },
          body: JSON.stringify({ email, password: 'long-test-password' }),
        },
      );
      assert.equal(res.status, 200);
      return ((await res.json()) as { token: string }).token;
    };

    const managerToken = await login('manager@brango.test', true);
    const peruToken = await login('peru@brango.test', false);
    const ecuadorToken = await login('ecuador@brango.test', false);

    // 1. Manager rotates Brango key with HMAC required
    const rotateRes = await fetch(
      base + '/v1/orders/integrations/brango/rotate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${managerToken}`,
          'X-Tenant-Host': 'brango.example',
        },
        body: JSON.stringify({ requireSignature: true }),
      },
    );
    assert.equal(rotateRes.status, 200);
    const creds = (await rotateRes.json()) as {
      apiKey: string;
      hmacSecret: string;
    };

    const sendSignedWebhook = async (payload: Record<string, unknown>) => {
      const bodyStr = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', creds.hmacSecret)
        .update(`${ts}.${bodyStr}`)
        .digest('hex');
      return fetch(base + '/v1/integrations/brango/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': creds.apiKey,
          'X-Brango-Timestamp': ts,
          'X-Brango-Signature': `sha256=${sig}`,
        },
        body: bodyStr,
      });
    };

    // 2. Reject invalid signature
    const badSigRes = await fetch(base + '/v1/integrations/brango/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': creds.apiKey,
        'X-Brango-Timestamp': String(Math.floor(Date.now() / 1000)),
        'X-Brango-Signature': 'sha256=' + '0'.repeat(64),
      },
      body: JSON.stringify({
        externalOrderId: 'BR-BAD',
        commercialPhone: '+51968995490',
        customerName: 'Test',
      }),
    });
    assert.equal(badSigRes.status, 401);

    // 3. Match +51 without '+' and with spaces (Peru)
    const okPeru = await sendSignedWebhook({
      externalOrderId: 'BR-1001',
      externalEventId: 'EV-1',
      originCode: 'IN_TRANSIT',
      commercialPhone: '51 968-995-490',
      customerName: 'Pet Market Lima',
      totalAmount: 'S/ 1,200.00',
    });
    assert.equal(okPeru.status, 200);
    const peruBody = (await okPeru.json()) as {
      linkStatus: string;
      membershipId: string;
    };
    assert.equal(peruBody.linkStatus, 'linked');
    assert.equal(peruBody.membershipId, commercialPeru.membershipId);

    // 4. Match +593 3-digit country code (Ecuador)
    const okEcu = await sendSignedWebhook({
      externalOrderId: 'BR-1002',
      externalEventId: 'EV-2',
      originCode: 'DELIVERED',
      commercialPhone: '+593 991234567',
      customerName: 'Vet Quito',
    });
    assert.equal(okEcu.status, 200);
    const ecuBody = (await okEcu.json()) as {
      linkStatus: string;
      membershipId: string;
    };
    assert.equal(ecuBody.linkStatus, 'linked');
    assert.equal(ecuBody.membershipId, commercialEcuador.membershipId);

    // 5. Unmatched phone goes to pending_link without failing
    const pendingRes = await sendSignedWebhook({
      externalOrderId: 'BR-1003',
      externalEventId: 'EV-3',
      originCode: 'PENDING',
      commercialPhone: '+573001112233',
      customerName: 'Tienda Bogota',
    });
    assert.equal(pendingRes.status, 200);
    const pendingBody = (await pendingRes.json()) as {
      id: string;
      linkStatus: string;
      membershipId: string | null;
    };
    assert.equal(pendingBody.linkStatus, 'pending_link');
    assert.equal(pendingBody.membershipId, null);

    // 6. Mobile scopes strictly per commercial
    const peruOrdersRes = await fetch(base + '/v1/field-operations/orders', {
      headers: {
        Authorization: `Bearer ${peruToken}`,
        'X-Tenant-Host': 'brango.example',
      },
    });
    assert.equal(peruOrdersRes.status, 200);
    const peruOrders = (await peruOrdersRes.json()) as {
      items: Array<{ externalOrderId: string }>;
    };
    assert.deepEqual(
      peruOrders.items.map((i) => i.externalOrderId),
      ['BR-1001'],
    );

    const ecuOrdersRes = await fetch(base + '/v1/field-operations/orders', {
      headers: {
        Authorization: `Bearer ${ecuadorToken}`,
        'X-Tenant-Host': 'brango.example',
      },
    });
    assert.equal(ecuOrdersRes.status, 200);
    const ecuOrders = (await ecuOrdersRes.json()) as {
      items: Array<{ externalOrderId: string }>;
    };
    assert.deepEqual(
      ecuOrders.items.map((i) => i.externalOrderId),
      ['BR-1002'],
    );

    // 7. Manager sees all 3 orders and KPIs, and can manually link BR-1003
    const mgrOrdersRes = await fetch(base + '/v1/orders', {
      headers: {
        Authorization: `Bearer ${managerToken}`,
        'X-Tenant-Host': 'brango.example',
      },
    });
    assert.equal(mgrOrdersRes.status, 200);
    const mgrOrders = (await mgrOrdersRes.json()) as {
      kpis: { total: number; pendingLinks: number };
    };
    assert.equal(mgrOrders.kpis.total, 3);
    assert.equal(mgrOrders.kpis.pendingLinks, 1);

    const linkRes = await fetch(base + `/v1/orders/${pendingBody.id}/link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managerToken}`,
        'X-Tenant-Host': 'brango.example',
      },
      body: JSON.stringify({ membershipId: commercialPeru.membershipId }),
    });
    assert.equal(linkRes.status, 200);
  } finally {
    await app?.close();
    await db.close();
  }
});

