/**
 * `POST /api/admin/service-api-keys`: the owner picks a key's scopes from the three the service
 * API knows, and the key that comes back is limited to them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import type { ObjectId } from '../src/db/object-id.ts';
import { signAccessToken, signStepUpToken } from '../src/auth/tokens.ts';
import { authenticateServiceApiKey } from '../src/auth/service-api-keys.ts';
import { serviceApiKeyAdminRoutes } from '../src/routes/service-api-keys.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedUser } from './helpers/sqlite-fixtures.ts';

process.env.MAPLE_JWT_SECRET ??= 'x'.repeat(32);

const app = new Elysia().use(new Elysia().use(serviceApiKeyAdminRoutes));
let live: LiveTestDatabase;
let owner: ObjectId;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  owner = seedUser(live.db, { email: 'owner@maple.test', role: 'owner' });
});

afterEach(() => live.close());

async function mint(body: Record<string, unknown>): Promise<Response> {
  const secret = process.env.MAPLE_JWT_SECRET!;
  const sub = owner.toHexString();
  const bearer = await signAccessToken(
    { sub, email: 'owner@maple.test', role: 'owner', file_access: true },
    secret,
  );
  return app.handle(
    new Request('http://localhost/api/admin/service-api-keys', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
        'x-step-up': await signStepUpToken(sub, secret),
      },
      body: JSON.stringify(body),
    }),
  );
}

describe('minting service keys with scopes', () => {
  it('mints a key with the chosen scopes, owned by the minting user', async () => {
    const response = await mint({ name: 'Japanese Maple', scopes: ['people:read', 'assets:read'] });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { key: string; scopes: string[] };
    expect(created.scopes).toEqual(['people:read', 'assets:read']);

    const read = await authenticateServiceApiKey(`Bearer ${created.key}`, 'assets:read');
    expect(read).toMatchObject({ ok: true, identity: { ownerId: owner.toHexString() } });
    const searchAttempt = await authenticateServiceApiKey(`Bearer ${created.key}`, 'assets:search');
    expect(searchAttempt).toMatchObject({ ok: false, status: 403 });
  });

  it('keeps assets:search as the default scope', async () => {
    const response = await mint({ name: 'SugarMaple' });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { scopes: string[] }).scopes).toEqual(['assets:search']);
  });

  it('refuses a scope the service API does not know', async () => {
    const response = await mint({ name: 'Japanese Maple', scopes: ['assets:write'] });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
