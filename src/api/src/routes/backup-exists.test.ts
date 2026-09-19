/**
 * Route-integration test: POST /api/libraries/:libraryId/backup/exists
 *
 * The PhotoKit backup client computes a content-derived `maple_id` per local
 * photo and asks the server, in batches, which of those ids it does NOT
 * already have in a given library so it can skip re-uploading duplicates.
 *
 * Covers: missing ids returned, present ids excluded, presence scoped to the
 * requested library, a trashed location not counting as present, unknown
 * library → 404, invalid library id → 400, > 1000 ids → 400, empty array →
 * { missing: [] }, de-duplication + input-order preservation.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787) — nothing external to start, nothing left behind.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { seedBackupAsset, seedLibrary } from '../../tests/helpers/sqlite-fixtures.ts';
import { backupExistsRoutes } from './backup-exists.ts';

describe('POST /api/libraries/:libraryId/backup/exists', () => {
  let live: LiveTestDatabase;
  let libraryId: ObjectId;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    libraryId = seedLibrary(live.db, {
      path: '/tmp/maple-backup-exists-test',
      label: 'exists-test',
    });
  });

  afterEach(() => {
    live.close();
  });

  /** One asset carrying `mapleId`, with a single live location in `library` —
   * the shape backup-ingest's writer leaves behind. */
  function seedAsset(library: ObjectId, mapleId: string, deletedAt: string | null = null): void {
    seedBackupAsset(live.db, {
      mapleId,
      size: 4,
      locations: [{ libraryId: library, relPath: `${mapleId}.dng`, deletedAt }],
    });
  }

  function makeApp() {
    return new Elysia().use(backupExistsRoutes);
  }

  async function post(libId: string, body: unknown): Promise<Response> {
    return makeApp().handle(
      new Request(`http://localhost/api/libraries/${libId}/backup/exists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  it('returns ids that are not present and excludes those that are', async () => {
    seedAsset(libraryId, '02326e4802370e56c95b1b75b976ec74');
    seedAsset(libraryId, '0229d03e9b6a0dc6c1fb2d5c2772d62c');

    const res = await post(libraryId.toHexString(), {
      maple_ids: [
        '02326e4802370e56c95b1b75b976ec74',
        '0207b9137a8575b96dfa8e745187bd52',
        '0229d03e9b6a0dc6c1fb2d5c2772d62c',
        '02f3d72fdbc7589497c07f85d9cbfb67',
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { missing: string[] };
    // Present ids excluded; missing ones returned in input order.
    expect(body.missing).toEqual([
      '0207b9137a8575b96dfa8e745187bd52',
      '02f3d72fdbc7589497c07f85d9cbfb67',
    ]);
  });

  it('scopes presence to the requested library', async () => {
    // Seed the same maple_id but linked to a DIFFERENT library.
    const otherLibrary = seedLibrary(live.db, { path: '/tmp/maple-backup-exists-other' });
    seedAsset(otherLibrary, '02bfd7313542364285aa15157dffa946');

    const res = await post(libraryId.toHexString(), {
      maple_ids: ['02bfd7313542364285aa15157dffa946'],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { missing: string[] };
    // Present in another library, so still "missing" for this one.
    expect(body.missing).toEqual(['02bfd7313542364285aa15157dffa946']);
  });

  it('reports a trashed location as missing so the photo is re-uploaded', async () => {
    seedAsset(libraryId, '0246d5e6e1bfbc9b96c0d5e6c8a2f931', '2026-05-12T00:00:00Z');

    const res = await post(libraryId.toHexString(), {
      maple_ids: ['0246d5e6e1bfbc9b96c0d5e6c8a2f931'],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { missing: string[] };
    expect(body.missing).toEqual(['0246d5e6e1bfbc9b96c0d5e6c8a2f931']);
  });

  it('de-duplicates input ids and preserves first-seen order', async () => {
    seedAsset(libraryId, '02193c45b5281908d2d9c814ba73be69');

    const res = await post(libraryId.toHexString(), {
      maple_ids: [
        '02ca978112ca1bbdcafac231b39a23dc',
        '023e23e8160039594a33894f6564e1b1',
        '02ca978112ca1bbdcafac231b39a23dc',
        '02193c45b5281908d2d9c814ba73be69',
        '023e23e8160039594a33894f6564e1b1',
        '02193c45b5281908d2d9c814ba73be69',
        '022e7d2c03a9507ae265ecf5b5356885',
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { missing: string[] };
    // '02193c45b5281908d2d9c814ba73be69' excluded (present); duplicates collapsed; order preserved.
    expect(body.missing).toEqual([
      '02ca978112ca1bbdcafac231b39a23dc',
      '023e23e8160039594a33894f6564e1b1',
      '022e7d2c03a9507ae265ecf5b5356885',
    ]);
  });

  it('empty array yields an empty missing list', async () => {
    const res = await post(libraryId.toHexString(), { maple_ids: [] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { missing: string[] };
    expect(body.missing).toEqual([]);
  });

  it('unknown library → 404', async () => {
    const res = await post(new ObjectId().toHexString(), {
      maple_ids: ['02ee0874170b7f6f32b8c2ac9573c428'],
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('library not found');
  });

  it('invalid library id → 400', async () => {
    const res = await post('not-an-objectid', { maple_ids: ['02ee0874170b7f6f32b8c2ac9573c428'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid library id');
  });

  it('non-array maple_ids → 400', async () => {
    const res = await post(libraryId.toHexString(), { maple_ids: 'nope' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('maple_ids must be an array');
  });

  it('missing maple_ids field → 400', async () => {
    const res = await post(libraryId.toHexString(), {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('maple_ids must be an array');
  });

  it('more than 1000 ids → 400', async () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => i.toString(16).padStart(32, '0'));
    const res = await post(libraryId.toHexString(), { maple_ids: tooMany });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('too many ids (max 1000)');
  });

  it('accepts exactly 1000 ids', async () => {
    const exactly = Array.from({ length: 1000 }, (_, i) => i.toString(16).padStart(32, '0'));
    const res = await post(libraryId.toHexString(), { maple_ids: exactly });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { missing: string[] };
    // None seeded — all 1000 are missing.
    expect(body.missing).toHaveLength(1000);
  });
});
