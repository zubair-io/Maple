import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildApp } from '../../src/index.ts';
import { createInvite, redeemInvite, rescindInvite } from '../../src/auth/invites.ts';
import { verifyAccessToken } from '../../src/auth/tokens.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedUser } from '../helpers/sqlite-fixtures.ts';
import { buildRegistrationResponse } from './helpers/soft-authn.ts';

const SECRET = 'email-free-security-test-secret-only';
const app = buildApp({ stageNames: [] });
let live: LiveTestDatabase;
let source = 0;

beforeEach(async () => {
  process.env.MAPLE_JWT_SECRET = SECRET;
  process.env.MAPLE_RP_ID = 'localhost';
  process.env.MAPLE_ORIGIN = 'http://localhost:3000';
  live = await createLiveTestDatabase();
  source += 1;
});
afterEach(() => live.close());

function post(path: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${source}` },
      body: JSON.stringify(body),
    }),
  );
}

async function prepare(code: string, origin = 'http://localhost:3000') {
  const options = await post('register/options', { invite_code: code });
  expect(options.status).toBe(200);
  const { challenge } = (await options.json()) as { challenge: string };
  return buildRegistrationResponse({ challenge, rpId: 'localhost', origin });
}

const finish = (credential: unknown, code: string) =>
  post('register/verify', {
    invite_code: code,
    device_label: 'Security test',
    credential,
  });

describe('email-free registration security', () => {
  it('creates a member with no email and denies owner-only operations', async () => {
    const owner = seedUser(live.db, { email: null, role: 'owner' });
    const invite = await createInvite(owner);
    const built = await prepare(invite.code);
    const registered = await finish(built.response, invite.code);
    expect(registered.status).toBe(200);
    const body = (await registered.json()) as {
      access_token: string;
      user: { id: string; role: string; email: null };
    };
    expect(body.user.email).toBeNull();
    expect(body.user.role).toBe('member');
    const claims = await verifyAccessToken(body.access_token, SECRET);
    expect(claims.role).toBe('member');
    expect(claims.email).toBeNull();
    expect(
      (
        await app.handle(
          new Request('http://localhost/api/users', {
            headers: { authorization: `Bearer ${body.access_token}` },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.handle(
          new Request('http://localhost/api/auth/invites', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${body.access_token}`,
              'content-type': 'application/json',
            },
            body: '{}',
          }),
        )
      ).status,
    ).toBe(403);
    expect((await finish(built.response, invite.code)).status).toBeGreaterThanOrEqual(400);
  });

  it('allows exactly one member when two passkeys register using the same code', async () => {
    const owner = seedUser(live.db, { email: null, role: 'owner' });
    const invite = await createInvite(owner);
    const [a, b] = await Promise.all([prepare(invite.code), prepare(invite.code)]);
    const replies = await Promise.all([
      finish(a.response, invite.code),
      finish(b.response, invite.code),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 410]);
    expect(live.db.query('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 2 });
  });

  for (const invalidate of ['revoke', 'expire'] as const) {
    it(`rejects a code ${invalidate}d after registration options were issued`, async () => {
      const owner = seedUser(live.db, { email: null, role: 'owner' });
      const invite = await createInvite(owner);
      const built = await prepare(invite.code);
      if (invalidate === 'revoke') await rescindInvite(invite.code);
      else
        live.db.run('UPDATE invites SET expires_at = ? WHERE code = ?', [
          '2000-01-01T00:00:00.000Z',
          invite.code,
        ]);
      expect((await finish(built.response, invite.code)).status).toBe(410);
      expect(live.db.query('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
    });
  }

  it('does not substitute a different invite for the code bound to a ceremony', async () => {
    const owner = seedUser(live.db, { email: null, role: 'owner' });
    const first = await createInvite(owner);
    const second = await createInvite(owner);
    const built = await prepare(first.code);
    expect((await finish(built.response, second.code)).status).toBe(400);
    expect(live.db.query('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
    expect(
      live.db.query('SELECT COUNT(*) AS n FROM invites WHERE consumed_at IS NOT NULL').get(),
    ).toEqual({ n: 0 });
  });

  it('rejects an attestation from a different origin before spending the invite', async () => {
    const owner = seedUser(live.db, { email: null, role: 'owner' });
    const invite = await createInvite(owner);
    const built = await prepare(invite.code, 'https://attacker.invalid');
    expect((await finish(built.response, invite.code)).status).toBeGreaterThanOrEqual(400);
    expect(live.db.query('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
    expect(
      live.db.query('SELECT consumed_at FROM invites WHERE code = ?').get(invite.code),
    ).toEqual({ consumed_at: null });
  });

  it('spends a code atomically even when both redeemers read it before either update', async () => {
    const owner = seedUser(live.db, { email: null, role: 'owner' });
    const invite = await createInvite(owner);
    const results = await Promise.allSettled([
      redeemInvite(invite.code),
      redeemInvite(invite.code),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason.status).toBe(410);
  });

  it('refuses a revocation that races the initial read of an invite', async () => {
    const owner = seedUser(live.db, { email: null, role: 'owner' });
    const invite = await createInvite(owner);
    const [redeemed] = await Promise.allSettled([
      redeemInvite(invite.code),
      rescindInvite(invite.code),
    ]);
    expect(redeemed.status).toBe('rejected');
    expect(redeemed.status === 'rejected' && redeemed.reason.status).toBe(410);
  });
});
