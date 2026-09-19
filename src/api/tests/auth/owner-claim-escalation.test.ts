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
 * mirroring auth-flow-e2e.test.ts. Storage is a private SQLite database
 * installed as the process-wide handle for each test (#3787) — which is what
 * makes "users exist but the sentinel does not" a state each test can simply
 * seed, instead of one it has to carve out of a shared database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ObjectId } from 'mongodb';
import { buildApp } from '../../src/index.ts';
import { OWNER_CLAIM_ID, backfillOwnershipClaim } from '../../src/auth/server_claim.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedInvite, seedUser } from '../helpers/sqlite-fixtures.ts';
import { buildRegistrationResponse } from './helpers/soft-authn.ts';

process.env.MAPLE_RP_ID = 'localhost';
process.env.MAPLE_ORIGIN = 'http://localhost:3000';
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const app = buildApp({ stageNames: [] });

let live: LiveTestDatabase;

beforeEach(async () => {
  live = await createLiveTestDatabase();
});

afterEach(() => {
  live.close();
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
function seedDevLoginStyleOwner(): ObjectId {
  return seedUser(live.db, { email: 'operator@maple.test', role: 'owner' });
}

/** True when the ownership sentinel row is planted. */
function sentinelPlanted(): boolean {
  return live.db.query(`SELECT id FROM server_state WHERE id = ?`).get(OWNER_CLAIM_ID) !== null;
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
    const ownerID = seedDevLoginStyleOwner();
    const code = 'INVITE01';
    seedInvite(live.db, {
      code,
      email: 'invitee@maple.test',
      invitedBy: ownerID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await registerInvited('invitee@maple.test', code, '203.0.113.10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { role: string } };
    expect(body.user?.role).toBe('member');

    // The invite was consumed on the member path.
    const invite = live.db.query(`SELECT consumed_at FROM invites WHERE code = ?`).get(code) as {
      consumed_at: string | null;
    } | null;
    expect(invite?.consumed_at).not.toBeNull();

    // And the stored row agrees with the response.
    const stored = live.db
      .query(`SELECT role FROM users WHERE email = ?`)
      .get('invitee@maple.test') as { role: string } | null;
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
    expect(sentinelPlanted()).toBe(true);
  });

  it('backfillOwnershipClaim plants the sentinel only when users exist', async () => {
    // Fresh install: no users → no sentinel (first registration must claim).
    await backfillOwnershipClaim();
    expect(sentinelPlanted()).toBe(false);

    // Pre-sentinel install: users exist → sentinel planted, idempotently.
    seedDevLoginStyleOwner();
    await backfillOwnershipClaim();
    expect(sentinelPlanted()).toBe(true);
    await backfillOwnershipClaim();
    expect(sentinelPlanted()).toBe(true);
  });

  it('dev-login plants the sentinel alongside the owner it creates', async () => {
    process.env.MAPLE_DEV_AUTH = '1';
    try {
      const res = await post('/api/auth/dev-login', { email: 'dev@maple.local' }, '203.0.113.12');
      expect(res.status).toBe(200);
      expect(sentinelPlanted()).toBe(true);
    } finally {
      delete process.env.MAPLE_DEV_AUTH;
    }
  });
});
