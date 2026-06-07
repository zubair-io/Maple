/**
 * token_version instant revoke (#860).
 *
 * A bumped `token_version` must invalidate every live access token for that user
 * within one `requireAuth` verify — the "kill this user now" lever a short TTL
 * alone can't provide. Driven through the real assembled app + /api/auth/me.
 */
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

import { describe, it, expect, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { buildApp } from '../../src/index.ts';
import { signAccessToken } from '../../src/auth/tokens.ts';
import { bumpTokenVersion } from '../../src/auth/token_version.ts';
import { usersCollection } from '../../src/db/client.ts';

const app = buildApp({ stageNames: [] });
const SECRET = process.env.MAPLE_JWT_SECRET!;
const EMAIL = 'owner@maple.test';

let userId: ObjectId;

beforeEach(async () => {
  const users = await usersCollection();
  await users.deleteMany({});
  const ins = await users.insertOne({
    email: EMAIL,
    role: 'owner',
    created_at: new Date().toISOString(),
    last_seen_at: null,
    token_version: 0,
  });
  userId = ins.insertedId;
});

const me = (bearer: string) =>
  app.handle(
    new Request('http://localhost/api/auth/me', {
      headers: { authorization: `Bearer ${bearer}` },
    }),
  );

describe('token_version instant revoke (#860)', () => {
  it('accepts a matching token, rejects it after a bump, accepts a fresh one', async () => {
    const t0 = await signAccessToken(
      { sub: userId.toHexString(), email: EMAIL, role: 'owner', token_version: 0 },
      SECRET,
    );
    expect((await me(t0)).status).toBe(200);

    // Instant revoke.
    await bumpTokenVersion(userId);

    // The same still-unexpired token is now rejected within one verify.
    expect((await me(t0)).status).toBe(401);

    // A freshly-minted token (tv now 1) is accepted again.
    const t1 = await signAccessToken(
      { sub: userId.toHexString(), email: EMAIL, role: 'owner', token_version: 1 },
      SECRET,
    );
    expect((await me(t1)).status).toBe(200);
  });

  it('falls through to a stateless accept for a signed bearer with no user row', async () => {
    // Keeps signed-but-userless bearers (test/bootstrap) working; bounded by the
    // short access TTL.
    const ghost = await signAccessToken(
      { sub: new ObjectId().toHexString(), email: 'ghost@maple.test', role: 'owner' },
      SECRET,
    );
    expect((await me(ghost)).status).toBe(200);
  });
});
