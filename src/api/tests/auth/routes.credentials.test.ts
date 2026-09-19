/**
 * Passkey management on an existing account: listing the passkeys on `/me`, and
 * the removal rule that an account can never be left without one.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787), so the routes reach it through the same `sqliteDb()`
 * they use in production and each test starts from an account with exactly the
 * passkeys it seeded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import type { ObjectId } from '../../src/db/object-id.ts';
import { authRoutes } from '../../src/routes/auth.ts';
import { accountRoutes } from '../../src/routes/auth-account.ts';
import { signAccessToken, signStepUpToken } from '../../src/auth/tokens.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedCredential, seedUser } from '../helpers/sqlite-fixtures.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
// /me + /credentials live in accountRoutes (#861 extraction); mount both.
const app = new Elysia().use(authRoutes).use(accountRoutes);

let live: LiveTestDatabase;
let userId: ObjectId;
let jwt: string;
let stepUp: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  userId = seedUser(live.db, { email: 'u@m.c', role: 'member' });
  jwt = await signAccessToken(
    { file_access: true, sub: userId.toHexString(), email: 'u@m.c', role: 'member' },
    'x'.repeat(32),
  );
  // #861: removing a credential is sensitive — needs a fresh step-up token.
  stepUp = await signStepUpToken(userId.toHexString(), 'x'.repeat(32));
});

afterEach(() => {
  live.close();
});

describe('credentials', () => {
  it('returns 409 when removing the last credential', async () => {
    const credId = seedCredential(live.db, {
      userId,
      credentialId: 'c1',
      deviceLabel: 'iPhone',
    });
    const r = await app.handle(
      new Request(`http://localhost/api/auth/credentials/${credId.toHexString()}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${jwt}`, 'x-step-up': stepUp },
      }),
    );
    expect(r.status).toBe(409);
  });

  it('removes a credential when more than one exists', async () => {
    const a = seedCredential(live.db, { userId, credentialId: 'c1', deviceLabel: 'iPhone' });
    seedCredential(live.db, { userId, credentialId: 'c2', deviceLabel: 'Mac' });
    const r = await app.handle(
      new Request(`http://localhost/api/auth/credentials/${a.toHexString()}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${jwt}`, 'x-step-up': stepUp },
      }),
    );
    expect(r.status).toBe(204);
  });

  it('/me returns credentials list', async () => {
    seedCredential(live.db, { userId, credentialId: 'c1', deviceLabel: 'iPhone' });
    const r = await app.handle(
      new Request('http://localhost/api/auth/me', {
        headers: { authorization: `Bearer ${jwt}` },
      }),
    );
    const body = (await r.json()) as { credentials: { device_label: string }[] };
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0].device_label).toBe('iPhone');
  });
});
