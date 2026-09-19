/**
 * Route-integration test: GET /api/changes — the polling half of the change
 * feed the File Provider extension syncs against.
 *
 * Journal rows are made with `recordAssetChange` from the SQLite repository
 * (#3787). There is no separate cursor allocation to perform any more:
 * `asset_changes.cursor` is an INTEGER PRIMARY KEY, so the insert mints it, and
 * the Mongo repo's `allocateCursor` — which handed back a cursor with no row
 * attached — is gone rather than ported.
 *
 * Each test gets a private database installed as the process-wide handle, which
 * is what the route resolves; that also replaces the per-test `deleteMany({})`
 * on `asset_changes` and `server_state`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import { changesRoutes } from './changes.ts';
import { recordAssetChange, recordAssetChangeRow } from '../db/sqlite/repos/changes.repo.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let app: Pick<Elysia, 'handle'>;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  app = new Elysia().use(fakeAuth()).use(changesRoutes);
});

afterEach(() => {
  live.close();
});

describe('GET /api/changes', () => {
  it('returns rows with cursor > since', async () => {
    for (let i = 0; i < 3; i++) {
      await recordAssetChange(live.handle, {
        kind: 'create',
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        abs_path: `/p/${i}.dng`,
      });
    }
    const res = await app.handle(new Request('http://localhost/api/changes?since=0'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changes.length).toBe(3);
    expect(body.next_cursor).toBeGreaterThan(0);
  });

  it('returns empty list with no next_cursor when no changes', async () => {
    const res = await app.handle(new Request('http://localhost/api/changes?since=0'));
    const body = await res.json();
    expect(body.changes).toEqual([]);
    expect(body.next_cursor).toBeUndefined();
  });

  it('returns 400 for non-integer limit (regression — used to 500)', async () => {
    const res = await app.handle(new Request('http://localhost/api/changes?since=0&limit=abc'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/limit/i);
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      await recordAssetChange(live.handle, {
        kind: 'create',
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        abs_path: `/p/${i}.dng`,
      });
    }
    const res = await app.handle(new Request('http://localhost/api/changes?since=0&limit=3'));
    const body = await res.json();
    expect(body.changes.length).toBe(3);
  });

  it('emits relative_path: null (explicit) for a row that carries none', async () => {
    // Regression — Phase 6 wire format: explicit null is the contract.
    // Apple's decoder uses `decodeIfPresent` so it tolerates the key being
    // missing, but the wire format guarantees the key is present (with
    // `?? null`) so downstream consumers can rely on its existence —
    // asserting the explicit-null shape protects against accidental drift in
    // `asPayload`. On Mongo the fixture was a hand-written document with the
    // field absent from the BSON; the column is NOT NULL-free here, so a row
    // written without a relative path IS that state.
    await recordAssetChangeRow(live.handle, {
      kind: 'update',
      asset_id: new ObjectId(),
      folder_id: new ObjectId(),
      abs_path: '/p/legacy.dng',
    });
    const res = await app.handle(new Request('http://localhost/api/changes?since=0'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changes.length).toBe(1);
    const row = body.changes[0];
    // The key must be present AND its value must be `null` — not
    // `undefined` (which would be elided by JSON.stringify).
    expect(Object.prototype.hasOwnProperty.call(row, 'relative_path')).toBe(true);
    expect(row.relative_path).toBeNull();
  });
});
