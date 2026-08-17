/**
 * #2920 — invited registrant must NEVER become owner, even when the
 * `owner_claim` sentinel is missing.
 *
 * The reported escalation: an install whose owner was created outside the
 * WebAuthn claim flow (dev-login, or pre-#865) has users but no sentinel.
 * `isClaimed()` (any-user-exists) correctly demanded an invite — but
 * `register/verify`'s unconditional `tryClaimOwnership()` found the
 * sentinel slot free and crowned the INVITED registrant owner, without
 * even consuming their invite.
 *
 * Drives the real assembled app over the soft-authenticator ceremony,
 * mirroring auth-flow-e2e.test.ts. Real Mongo required (skips when
 * unreachable via the shared harness convention: collections just fail).
 */
process.env.MAPLE_RP_ID = 'localhost';
process.env.MAPLE_ORIGIN = 'http://localhost:3000';
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

import { describe, it, expect, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { buildApp } from '../../src/index.ts';
import {
  usersCollection,
  credentialsCollection,
  invitesCollection,
  challengesCollection,
  serverStateCollection,
} from '../../src/db/client.ts';
import { OWNER_CLAIM_ID, backfillOwnershipClaim } from '../../src/auth/server_claim.ts';
import { withTestDb } from '../../src/db/test-db.test-helpers.ts';
import { buildRegistrationResponse } from './helpers/soft-authn.ts';

// Per-file database (#2900) — standalone runs must never touch the dev DB.
withTestDb(`maple_test_owner_claim_${process.pid}`);

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const app = buildApp({ stageNames: [] });

beforeEach(async () => {
  for (const c of [
    usersCollection,
    credentialsCollection,
    invitesCollection,
    challengesCollection,
  ]) {
    await (await c()).deleteMany({});
  }
  await (await serverStateCollection()).deleteOne({ _id: OWNER_CLAIM_ID });
});

function post(path: string, body: unknown, ip: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    }),
  );
}

/** Seed an owner the way dev-login does: user row only, NO sentinel. */
async function seedDevLoginStyleOwner(): Promise<ObjectId> {
  const ins = await (
    await usersCollection()
  ).insertOne({
    email: 'operator@maple.test',
    role: 'owner',
    created_at: new Date().toISOString(),
    last_seen_at: null,
  });
  return ins.insertedId;
}

async function seedInvite(email: string, invitedBy: ObjectId): Promise<string> {
  const code = 'INVITE01';
  await (
    await invitesCollection()
  ).insertOne({
    code,
    email,
    invited_by: invitedBy,
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
    consumed_at: null,
  });
  return code;
}

/** The invited-member registration ceremony (options → soft-authn → verify). */
async function registerInvited(email: string, inviteCode: string, ip: string) {
  const optsRes = await post('/api/auth/register/options', { email, invite_code: inviteCode }, ip);
  expect(optsRes.status).toBe(200);
  const { challenge } = (await optsRes.json()) as { challenge: string };
  const built = await buildRegistrationResponse({ challenge, rpId: RP_ID, origin: ORIGIN });
  const verifyRes = await post(
    '/api/auth/register/verify',
    { email, device_label: 'phone', credential: built.response },
    ip,
  );
  return verifyRes;
}

describe('owner-claim escalation (#2920)', () => {
  it('an invited registrant is a MEMBER even when the sentinel is missing', async () => {
    const ownerID = await seedDevLoginStyleOwner();
    const code = await seedInvite('invitee@maple.test', ownerID);

    const res = await registerInvited('invitee@maple.test', code, '203.0.113.10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { role: string } };
    expect(body.user?.role).toBe('member');

    // The invite was consumed on the member path.
    const invite = await (await invitesCollection()).findOne({ code });
    expect(invite?.consumed_at).not.toBeNull();

    // And the stored row agrees with the response.
    const stored = await (await usersCollection()).findOne({ email: 'invitee@maple.test' });
    expect(stored?.role).toBe('member');
  });

  it('a genuinely fresh install still claims ownership on first registration', async () => {
    const optsRes = await post(
      '/api/auth/register/options',
      { email: 'first@maple.test' },
      '203.0.113.11',
    );
    expect(optsRes.status).toBe(200);
    const { challenge } = (await optsRes.json()) as { challenge: string };
    const built = await buildRegistrationResponse({ challenge, rpId: RP_ID, origin: ORIGIN });
    const verifyRes = await post(
      '/api/auth/register/verify',
      { email: 'first@maple.test', device_label: 'laptop', credential: built.response },
      '203.0.113.11',
    );
    expect(verifyRes.status).toBe(200);
    const body = (await verifyRes.json()) as { user?: { role: string } };
    expect(body.user?.role).toBe('owner');
    expect(await (await serverStateCollection()).findOne({ _id: OWNER_CLAIM_ID })).not.toBeNull();
  });

  it('backfillOwnershipClaim plants the sentinel only when users exist', async () => {
    // Fresh install: no users → no sentinel (first registration must claim).
    await backfillOwnershipClaim();
    expect(await (await serverStateCollection()).findOne({ _id: OWNER_CLAIM_ID })).toBeNull();

    // Pre-sentinel install: users exist → sentinel planted, idempotently.
    await seedDevLoginStyleOwner();
    await backfillOwnershipClaim();
    expect(await (await serverStateCollection()).findOne({ _id: OWNER_CLAIM_ID })).not.toBeNull();
    await backfillOwnershipClaim();
  });

  it('dev-login plants the sentinel alongside the owner it creates', async () => {
    process.env.MAPLE_DEV_AUTH = '1';
    try {
      const res = await post('/api/auth/dev-login', { email: 'dev@maple.local' }, '203.0.113.12');
      expect(res.status).toBe(200);
      expect(await (await serverStateCollection()).findOne({ _id: OWNER_CLAIM_ID })).not.toBeNull();
    } finally {
      delete process.env.MAPLE_DEV_AUTH;
    }
  });
});
