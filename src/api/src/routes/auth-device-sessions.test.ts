/**
 * Route-integration tests for the paired-device session endpoints (Maple TV
 * epic, milestone B, task B3, #2075).
 *
 * Mint requires the caller's OWN live refresh token in the body as proof of a
 * persistent credential; list surfaces only platform-marked families; revoke
 * is step-up-gated. Mirrors the bootstrap of the sibling auth route tests
 * (tests/auth/routes.native-code.test.ts, tests/auth/refresh-body-rotation.test.ts):
 * real Mongo via the default `db/client.ts` connection (mongodb://localhost:27017,
 * db "maple"), a directly-signed bearer JWT (no WebAuthn ceremony), collections
 * cleared in `beforeEach`. Distinct `x-forwarded-for` IPs per external call so
 * the shared `auth:<ip>` rate-limit bucket (10/min, `../auth/rate_limit.ts`)
 * doesn't trip across cases sharing this process with other auth test files.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { Elysia } from 'elysia';
import type { ObjectId } from 'mongodb';
import { authRoutes } from './auth.ts';
import { authDeviceSessionRoutes } from './auth-device-sessions.ts';
import { usersCollection, refreshTokensCollection } from '../db/client.ts';
import { signAccessToken, signStepUpToken } from '../auth/tokens.ts';
import { issueRefreshToken } from '../auth/refresh_store.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

// Mirror index.ts: wrap the self-gating device-session routes so their
// `requireAuth` scoped-derive stays contained and doesn't leak forward.
const app = new Elysia()
  .use(authRoutes)
  .use(new Elysia().use(authDeviceSessionRoutes));

let ipCounter = 0;
/** A fresh IP per call keeps the shared `auth:<ip>` limiter from tripping
 * across cases (same convention as refresh-body-rotation.test.ts). */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

async function seedUser(email: string): Promise<ObjectId> {
  const ins = await (
    await usersCollection()
  ).insertOne({
    email,
    role: 'owner',
    created_at: new Date().toISOString(),
    last_seen_at: null,
  });
  return ins.insertedId;
}

async function bearerFor(userId: ObjectId, email: string): Promise<string> {
  return signAccessToken(
    { sub: userId.toHexString(), email, role: 'owner' },
    process.env.MAPLE_JWT_SECRET!,
  );
}

function mint(bearer: string | undefined, body: Record<string, unknown>) {
  return app.handle(
    new Request('http://localhost/api/auth/device-sessions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': nextIp(),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function list(bearer: string) {
  return app.handle(
    new Request('http://localhost/api/auth/device-sessions', {
      headers: { authorization: `Bearer ${bearer}`, 'x-forwarded-for': nextIp() },
    }),
  );
}

function revoke(bearer: string, id: string, stepUp?: string) {
  return app.handle(
    new Request(`http://localhost/api/auth/device-sessions/${id}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${bearer}`,
        'x-forwarded-for': nextIp(),
        ...(stepUp ? { 'x-step-up': stepUp } : {}),
      },
    }),
  );
}

function refresh(token: string) {
  return app.handle(
    new Request('http://localhost/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ refresh_token: token }),
    }),
  );
}

beforeEach(async () => {
  await (await usersCollection()).deleteMany({});
  await (await refreshTokensCollection()).deleteMany({});
});

describe('device-session routes (#2075)', () => {
  it('mints a device session from the caller\'s own live refresh token, in a new family that rotates', async () => {
    const userId = await seedUser('owner@maple.test');
    const bearer = await bearerFor(userId, 'owner@maple.test');
    const own = await issueRefreshToken(userId, 'Safari on Mac');

    const res = await mint(bearer, {
      label: 'Living Room',
      platform: 'tvos',
      refresh_token: own.raw,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id?: string;
      access_token?: string;
      refresh_token?: string;
    };
    expect(typeof body.id).toBe('string');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    // A new family, not the caller's own login family.
    expect(body.id).not.toBe(own.familyId.toHexString());

    // The minted refresh token rotates successfully.
    const rot = await refresh(body.refresh_token!);
    expect(rot.status).toBe(200);
  });

  it('rejects mint with a bogus, expired, or other-user refresh_token (403); nothing is minted', async () => {
    const userId = await seedUser('owner2@maple.test');
    const bearer = await bearerFor(userId, 'owner2@maple.test');

    // Bogus token.
    const bogus = await mint(bearer, {
      label: 'Kitchen',
      platform: 'tvos',
      refresh_token: 'not-a-real-token',
    });
    expect(bogus.status).toBe(403);

    // Expired-but-unrevoked token (belongs to the caller).
    const expired = await issueRefreshToken(userId, 'Old Session');
    await (
      await refreshTokensCollection()
    ).updateOne(
      { family_id: expired.familyId },
      { $set: { expires_at: new Date(Date.now() - 1000) } },
    );
    const expiredRes = await mint(bearer, {
      label: 'Kitchen',
      platform: 'tvos',
      refresh_token: expired.raw,
    });
    expect(expiredRes.status).toBe(403);

    // Another user's live token.
    const otherUserId = await seedUser('someone-else@maple.test');
    const otherToken = await issueRefreshToken(otherUserId, 'Someone Else Session');
    const otherRes = await mint(bearer, {
      label: 'Kitchen',
      platform: 'tvos',
      refresh_token: otherToken.raw,
    });
    expect(otherRes.status).toBe(403);

    const listed = await list(bearer);
    const listedBody = (await listed.json()) as { sessions: unknown[] };
    expect(listedBody.sessions).toHaveLength(0);
  });

  it('rejects mint with no Authorization header (401)', async () => {
    const res = await mint(undefined, {
      label: 'Kitchen',
      platform: 'tvos',
      refresh_token: 'irrelevant',
    });
    expect(res.status).toBe(401);
  });

  it('GET lists the minted session (label, platform, id); a plain login family is absent', async () => {
    const userId = await seedUser('owner3@maple.test');
    const bearer = await bearerFor(userId, 'owner3@maple.test');
    const own = await issueRefreshToken(userId, 'Safari on Mac'); // plain login

    const mintRes = await mint(bearer, {
      label: 'Bedroom TV',
      platform: 'tvos',
      refresh_token: own.raw,
    });
    expect(mintRes.status).toBe(200);
    const { id } = (await mintRes.json()) as { id: string };

    const res = await list(bearer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ id: string; label: string; platform: string }>;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ id, label: 'Bedroom TV', platform: 'tvos' });
    // The plain login family never shows up.
    expect(body.sessions.some((s) => s.id === own.familyId.toHexString())).toBe(false);
  });

  it('DELETE without X-Step-Up header is rejected (403, "step-up required")', async () => {
    const userId = await seedUser('owner4@maple.test');
    const bearer = await bearerFor(userId, 'owner4@maple.test');
    const own = await issueRefreshToken(userId, 'Safari on Mac');
    const mintRes = await mint(bearer, {
      label: 'Office TV',
      platform: 'tvos',
      refresh_token: own.raw,
    });
    const { id } = (await mintRes.json()) as { id: string };

    const res = await revoke(bearer, id);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('step-up required');
  });

  it('DELETE with a valid step-up token revokes (204); GET is empty; the token no longer rotates', async () => {
    const userId = await seedUser('owner5@maple.test');
    const bearer = await bearerFor(userId, 'owner5@maple.test');
    const own = await issueRefreshToken(userId, 'Safari on Mac');
    const mintRes = await mint(bearer, {
      label: 'Garage TV',
      platform: 'tvos',
      refresh_token: own.raw,
    });
    const { id, refresh_token: mintedRefresh } = (await mintRes.json()) as {
      id: string;
      refresh_token: string;
    };

    const stepUp = await signStepUpToken(userId.toHexString(), process.env.MAPLE_JWT_SECRET!);
    const res = await revoke(bearer, id, stepUp);
    expect(res.status).toBe(204);

    const after = await list(bearer);
    const afterBody = (await after.json()) as { sessions: unknown[] };
    expect(afterBody.sessions).toHaveLength(0);

    const rot = await refresh(mintedRefresh);
    expect(rot.status).toBe(401);
  });

  it('DELETE for a family id belonging to another user is 404', async () => {
    const userId = await seedUser('owner6@maple.test');
    const bearer = await bearerFor(userId, 'owner6@maple.test');
    const own = await issueRefreshToken(userId, 'Safari on Mac');
    const mintRes = await mint(bearer, {
      label: 'Den TV',
      platform: 'tvos',
      refresh_token: own.raw,
    });
    const { id } = (await mintRes.json()) as { id: string };

    const otherUserId = await seedUser('intruder@maple.test');
    const otherBearer = await bearerFor(otherUserId, 'intruder@maple.test');
    const otherStepUp = await signStepUpToken(
      otherUserId.toHexString(),
      process.env.MAPLE_JWT_SECRET!,
    );

    const res = await revoke(otherBearer, id, otherStepUp);
    expect(res.status).toBe(404);
  });
});
