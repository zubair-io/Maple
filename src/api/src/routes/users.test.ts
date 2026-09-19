/**
 * Route-integration test: GET /api/users + PATCH /api/users/:id (#2893).
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for the duration of each test (#3787), so the handlers reach it through the
 * same `sqliteDb()` they use in production. Nothing external is needed and
 * nothing is left behind — the database goes away with the test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { seedUser } from '../../tests/helpers/sqlite-fixtures.ts';
import { signAccessToken } from '../auth/tokens.ts';
import { usersRoutes } from './users.ts';

const SECRET = 'x'.repeat(32);

describe('users routes (#2893)', () => {
  let live: LiveTestDatabase;
  let ownerId: ObjectId;
  let memberId: ObjectId;
  const app = new Elysia().use(usersRoutes);

  beforeEach(async () => {
    process.env.MAPLE_JWT_SECRET = SECRET;
    live = await createLiveTestDatabase();
    ownerId = seedUser(live.db, {
      email: 'owner@x.y',
      role: 'owner',
      createdAt: '2026-01-01T00:00:00Z',
    });
    memberId = seedUser(live.db, {
      email: 'member@x.y',
      role: 'member',
      createdAt: '2026-01-02T00:00:00Z',
    });
  });

  afterEach(() => {
    live.close();
  });

  /** The stored row, for assertions that the write actually landed. */
  function storedUser(id: ObjectId): { role: string; file_access: number | null } {
    return live.db
      .query(`SELECT role, file_access FROM users WHERE id = ?`)
      .get(id.toHexString()) as {
      role: string;
      file_access: number | null;
    };
  }

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
    const r = await app.handle(
      req('/', { headers: { authorization: await bearer('member', memberId) } }),
    );
    expect(r.status).toBe(403);
  });

  it('revokes and restores a member file_access via PATCH', async () => {
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

    expect(storedUser(memberId).file_access).toBe(0);

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
    expect(storedUser(memberId).role).toBe('member');
  });

  it('409s demoting the only owner (#2921 last-owner guard)', async () => {
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
