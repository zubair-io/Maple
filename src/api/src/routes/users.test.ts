/**
 * Route-integration test: GET /api/users + PATCH /api/users/:id (#2893).
 *
 * Requires a running MongoDB (skips gracefully if unreachable).
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { closeDb } from '../db/client.ts';
import { signAccessToken } from '../auth/tokens.ts';
import { usersRoutes } from './users.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_users_routes_test_${process.pid}`;
const SECRET = 'x'.repeat(32);

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

describe('users routes (#2893)', () => {
  let mongo: MongoClient | null = null;
  let db: Db | null = null;
  let ownerId: ObjectId;
  let memberId: ObjectId;
  const app = new Elysia().use(usersRoutes);

  beforeEach(async () => {
    mongo = await tryConnect();
    if (!mongo) return;
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = TEST_DB;
    process.env.MAPLE_JWT_SECRET = SECRET;
    await closeDb();
    db = mongo.db(TEST_DB);
    await db.dropDatabase();
    ownerId = new ObjectId();
    memberId = new ObjectId();
    await db.collection('users').insertMany([
      {
        _id: ownerId,
        email: 'owner@x.y',
        role: 'owner',
        created_at: '2026-01-01T00:00:00Z',
        last_seen_at: null,
      },
      {
        _id: memberId,
        email: 'member@x.y',
        role: 'member',
        created_at: '2026-01-02T00:00:00Z',
        last_seen_at: null,
      },
    ]);
  });

  afterAll(async () => {
    if (db) await db.dropDatabase();
    await closeDb();
    if (mongo) await mongo.close();
  });

  async function bearer(role: 'owner' | 'member', sub: ObjectId): Promise<string> {
    return `Bearer ${await signAccessToken(
      { sub: sub.toHexString(), email: `${role}@x.y`, role, file_access: true },
      SECRET,
    )}`;
  }

  function req(path: string, init: RequestInit = {}) {
    return new Request(`http://localhost/api/users${path}`, init);
  }

  it('lists every user with resolved file_access for the owner', async () => {
    if (!mongo) return;
    const r = await app.handle(
      req('/', { headers: { authorization: await bearer('owner', ownerId) } }),
    );
    expect(r.status).toBe(200);
    const users = (await r.json()) as { email: string; file_access: boolean }[];
    expect(users.map((u) => u.email)).toEqual(['owner@x.y', 'member@x.y']);
    // Absent field resolves to granted for both.
    expect(users.every((u) => u.file_access)).toBe(true);
  });

  it('403s a member on the roster', async () => {
    if (!mongo) return;
    const r = await app.handle(
      req('/', { headers: { authorization: await bearer('member', memberId) } }),
    );
    expect(r.status).toBe(403);
  });

  it('revokes and restores a member file_access via PATCH', async () => {
    if (!mongo) return;
    const auth = { authorization: await bearer('owner', ownerId) };
    const revoke = await app.handle(
      req(`/${memberId.toHexString()}`, {
        method: 'PATCH',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ file_access: false }),
      }),
    );
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as { file_access: boolean }).file_access).toBe(false);

    const stored = await db!.collection('users').findOne({ _id: memberId });
    expect(stored!.file_access).toBe(false);

    const restore = await app.handle(
      req(`/${memberId.toHexString()}`, {
        method: 'PATCH',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ file_access: true }),
      }),
    );
    expect(((await restore.json()) as { file_access: boolean }).file_access).toBe(true);
  });

  it('rejects revoking the owner', async () => {
    if (!mongo) return;
    const r = await app.handle(
      req(`/${ownerId.toHexString()}`, {
        method: 'PATCH',
        headers: {
          authorization: await bearer('owner', ownerId),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ file_access: false }),
      }),
    );
    expect(r.status).toBe(400);
  });

  it('promotes a member to owner and back via PATCH role (#2921)', async () => {
    if (!mongo) return;
    const auth = { authorization: await bearer('owner', ownerId) };
    const promote = await app.handle(
      req(`/${memberId.toHexString()}`, {
        method: 'PATCH',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'owner' }),
      }),
    );
    expect(promote.status).toBe(200);
    expect(((await promote.json()) as { role: string }).role).toBe('owner');

    // Two owners now — demoting one is allowed.
    const demote = await app.handle(
      req(`/${memberId.toHexString()}`, {
        method: 'PATCH',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'member' }),
      }),
    );
    expect(demote.status).toBe(200);
    expect(((await demote.json()) as { role: string }).role).toBe('member');
    const stored = await db!.collection('users').findOne({ _id: memberId });
    expect(stored!.role).toBe('member');
  });

  it('409s demoting the only owner (#2921 last-owner guard)', async () => {
    if (!mongo) return;
    const r = await app.handle(
      req(`/${ownerId.toHexString()}`, {
        method: 'PATCH',
        headers: {
          authorization: await bearer('owner', ownerId),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ role: 'member' }),
      }),
    );
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain('only owner');
  });

  it('rejects toggling file_access on someone becoming an owner', async () => {
    if (!mongo) return;
    const r = await app.handle(
      req(`/${memberId.toHexString()}`, {
        method: 'PATCH',
        headers: {
          authorization: await bearer('owner', ownerId),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ role: 'owner', file_access: false }),
      }),
    );
    expect(r.status).toBe(400);
  });

  it('400s an empty patch', async () => {
    if (!mongo) return;
    const r = await app.handle(
      req(`/${memberId.toHexString()}`, {
        method: 'PATCH',
        headers: {
          authorization: await bearer('owner', ownerId),
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    );
    expect(r.status).toBe(400);
  });

  it('404s an unknown user id', async () => {
    if (!mongo) return;
    const r = await app.handle(
      req(`/${new ObjectId().toHexString()}`, {
        method: 'PATCH',
        headers: {
          authorization: await bearer('owner', ownerId),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ file_access: false }),
      }),
    );
    expect(r.status).toBe(404);
  });
});
