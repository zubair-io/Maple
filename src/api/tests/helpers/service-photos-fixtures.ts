/**
 * A disposable library with two users for the `/api/service/*` suites: an owner whose service
 * keys the tests mint, and a second member whose photos and people must never be visible.
 */

import { Elysia } from 'elysia';
import { createServiceApiKey } from '../../src/auth/service-api-keys.ts';
import { insertUser } from '../../src/db/repos/auth.users.repo.ts';
import { ObjectId } from '../../src/db/object-id.ts';
import type { ServiceApiScope } from '../../src/db/schema.ts';
import { seedSearchAsset, type SeedAsset } from '../../src/db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { _resetServiceSearchRateLimitsForTests } from '../../src/routes/service-asset-search.ts';
import { servicePhotosRoutes } from '../../src/routes/service-photos/index.ts';

const ALL_SCOPES: ServiceApiScope[] = ['assets:search', 'assets:read', 'people:read'];

export interface ServiceFixture {
  live: LiveTestDatabase;
  libraryId: string;
  ownerId: string;
  otherId: string;
  /** A key minted by the owner with every scope. */
  key: string;
  people: Map<string, string>;
  mintKey(scopes: ServiceApiScope[], createdBy?: string): Promise<string>;
  /** Seeds one photo for `owner` (default: the key owner) and returns its asset id. */
  photo(seed: SeedAsset, owner?: string): string;
  close(): void;
}

export async function createServiceFixture(options: { libraryRoot?: string } = {}) {
  const live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, {
    path: options.libraryRoot ?? '/lib',
    slug: 'service-photos',
  });
  const now = new Date().toISOString();
  const ownerId = await insertUser({
    email: 'owner@maple.test',
    role: 'owner',
    created_at: now,
    last_seen_at: null,
  });
  const otherId = await insertUser({
    email: 'member@maple.test',
    role: 'member',
    created_at: now,
    last_seen_at: null,
  });
  const people = new Map<string, string>();
  const mintKey = async (scopes: ServiceApiScope[], createdBy = ownerId.toHexString()) => {
    const created = await createServiceApiKey({
      name: 'Japanese Maple',
      scopes,
      createdBy: new ObjectId(createdBy),
    });
    return created.key;
  };
  _resetServiceSearchRateLimitsForTests();
  const fixture: ServiceFixture = {
    live,
    libraryId,
    ownerId: ownerId.toHexString(),
    otherId: otherId.toHexString(),
    key: await mintKey(ALL_SCOPES),
    people,
    mintKey,
    photo(seed, owner = ownerId.toHexString()) {
      const id = seedSearchAsset(live.db, libraryId, seed, people);
      run(live.db, 'UPDATE assets SET owner_id = ? WHERE id = ?', owner, id);
      return id;
    },
    close: () => live.close(),
  };
  return fixture;
}

const app = new Elysia().use(servicePhotosRoutes);

export function serviceRequest(
  path: string,
  key: string | null,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(key === null ? {} : { authorization: `Bearer ${key}` }),
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...init.headers,
  };
  return app.handle(
    new Request(`http://localhost/api/service${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      body:
        init.body === undefined
          ? undefined
          : typeof init.body === 'string'
            ? init.body
            : JSON.stringify(init.body),
    }),
  );
}

export async function search(key: string, body: unknown) {
  const response = await serviceRequest('/photos/search', key, { body });
  return { status: response.status, body: (await response.json()) as SearchBody };
}

interface SearchBody {
  total: number;
  days: Array<{ date: string; count: number; place: string | null }>;
  photos: Array<{
    assetId: string;
    capturedAt: string;
    place: {
      label: string | null;
      locality: string | null;
      region: string | null;
      countryCode: string | null;
    } | null;
    lat: number | null;
    lng: number | null;
    people: Array<{ id: string; name: string }>;
  }>;
  nextCursor: string | null;
  error?: string;
  message?: string;
}
