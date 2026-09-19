/**
 * Invite CRUD: only an owner may mint or withdraw one, and a minted code is
 * visible on the owner's pending list until it is withdrawn.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787). The owner account is seeded rather than implied by the
 * bearer token, because an invite row names the account that issued it and the
 * schema enforces that the account is real.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import { authRoutes } from '../../src/routes/auth.ts';
import { signAccessToken, signStepUpToken } from '../../src/auth/tokens.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedUser } from '../helpers/sqlite-fixtures.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const SECRET = 'x'.repeat(32);
const app = new Elysia().use(authRoutes);

const memberJwt = await signAccessToken(
  { file_access: true, sub: new ObjectId().toHexString(), email: 'm@m.c', role: 'member' },
  SECRET,
);

let live: LiveTestDatabase;
let ownerJwt: string;
// #861: create/rescind are sensitive — they need a fresh step-up token.
let ownerStepUp: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const ownerId = seedUser(live.db, { email: 'o@m.c', role: 'owner' });
  ownerJwt = await signAccessToken(
    { file_access: true, sub: ownerId.toHexString(), email: 'o@m.c', role: 'owner' },
    SECRET,
  );
  ownerStepUp = await signStepUpToken(ownerId.toHexString(), SECRET);
});

afterEach(() => {
  live.close();
});

const createInvite = (email: string) =>
  app.handle(
    new Request('http://localhost/api/auth/invites', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ownerJwt}`,
        'x-step-up': ownerStepUp,
      },
      body: JSON.stringify({ email }),
    }),
  );

describe('invites CRUD', () => {
  it('rejects member from POST /invites', async () => {
    const r = await app.handle(
      new Request('http://localhost/api/auth/invites', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${memberJwt}`,
        },
        body: JSON.stringify({ email: 'x@y.z' }),
      }),
    );
    expect(r.status).toBe(403);
  });

  it('owner creates and lists an invite', async () => {
    const r = await createInvite('alice@x.y');
    expect(r.status).toBe(200);
    const { code } = (await r.json()) as { code: string };

    const list = await app.handle(
      new Request('http://localhost/api/auth/invites', {
        headers: { authorization: `Bearer ${ownerJwt}` },
      }),
    );
    const items = (await list.json()) as { code: string }[];
    expect(items.find((i) => i.code === code)).toBeDefined();
  });

  it('owner rescinds an invite', async () => {
    const cr = await createInvite('alice@x.y');
    const { code } = (await cr.json()) as { code: string };
    const dr = await app.handle(
      new Request(`http://localhost/api/auth/invites/${code}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${ownerJwt}`, 'x-step-up': ownerStepUp },
      }),
    );
    expect(dr.status).toBe(204);
    expect(live.db.query(`SELECT code FROM invites WHERE code = ?`).get(code)).toBeNull();
  });
});
