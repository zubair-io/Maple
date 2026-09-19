/**
 * `video_geo_backfill_audit` behaviour through the repository.
 *
 * The property the migration depends on is idempotency: it processes an
 * unsorted batch, excludes the videos it has already judged, and has to be safe
 * to re-run after a crash. Keying the table on the video means a second verdict
 * for the same video replaces the first rather than appending — which is also
 * what makes "candidates minus rows" the remaining count.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import { newObjectIdHex } from '../object-id.ts';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import {
  countAuditRows,
  listAuditedAssetIds,
  recordAuditDecision,
} from './video-geo-audit.repo.ts';

const videoId = (): ObjectId => new ObjectId(newObjectIdHex());

interface AuditRow {
  maple_id: string | null;
  captured_at: string;
  decision: string;
  donor_id: string | null;
  donor_maple_id: string | null;
  donor_lat: number | null;
  donor_lng: number | null;
  delta_ms: number | null;
  at: string;
}

function readRow(db: ReturnType<typeof testSqliteDb>, id: ObjectId): Promise<AuditRow[]> {
  return db.read<AuditRow>(
    `SELECT maple_id, captured_at, decision, donor_id, donor_maple_id,
            donor_lat, donor_lng, delta_ms, at
       FROM video_geo_backfill_audit WHERE asset_id = ?`,
    [id.toHexString()],
  );
}

describe('recordAuditDecision', () => {
  test('stores a match verdict with the donor flattened into columns', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const video = videoId();
    const donor = videoId();

    await recordAuditDecision(
      video,
      {
        maple_id: 'maple:video-1',
        captured_at: '2026-04-01T10:00:00.000Z',
        decision: 'match',
        donor_id: donor,
        donor_maple_id: 'maple:photo-1',
        donor_gps: { lat: 42.6526, lng: -73.7562 },
        delta_ms: 42_000,
        at: '2026-04-02T00:00:00.000Z',
      },
      db,
    );

    expect((await readRow(db, video))[0]).toEqual({
      maple_id: 'maple:video-1',
      captured_at: '2026-04-01T10:00:00.000Z',
      decision: 'match',
      donor_id: donor.toHexString(),
      donor_maple_id: 'maple:photo-1',
      donor_lat: 42.6526,
      donor_lng: -73.7562,
      delta_ms: 42_000,
      at: '2026-04-02T00:00:00.000Z',
    });
  });

  test('stores a no-donor verdict with the donor columns empty', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const video = videoId();

    await recordAuditDecision(
      video,
      {
        maple_id: 'maple:video-2',
        captured_at: '2026-04-01T10:00:00.000Z',
        decision: 'no-donor',
        at: '2026-04-02T00:00:00.000Z',
      },
      db,
    );

    expect((await readRow(db, video))[0]).toMatchObject({
      decision: 'no-donor',
      donor_id: null,
      donor_lat: null,
      donor_lng: null,
      delta_ms: null,
    });
  });

  test('stores a skip verdict for a candidate with no usable timestamp', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const video = videoId();

    // The migration's short-circuit: an empty captured_at, so the row converges
    // instead of blocking the head of an unsorted batch forever.
    await recordAuditDecision(
      video,
      { maple_id: undefined, captured_at: '', decision: 'skip', at: '2026-04-02T00:00:00.000Z' },
      db,
    );

    expect((await readRow(db, video))[0]).toMatchObject({
      maple_id: null,
      captured_at: '',
      decision: 'skip',
    });
  });

  test('re-judging a video replaces its verdict rather than appending one', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const video = videoId();
    const donor = videoId();

    await recordAuditDecision(
      video,
      {
        maple_id: 'maple:video-3',
        captured_at: '2026-04-01T10:00:00.000Z',
        decision: 'no-donor',
        at: '2026-04-02T00:00:00.000Z',
      },
      db,
    );
    await recordAuditDecision(
      video,
      {
        maple_id: 'maple:video-3',
        captured_at: '2026-04-01T10:00:00.000Z',
        decision: 'match',
        donor_id: donor,
        donor_gps: { lat: 1.5, lng: 2.5 },
        delta_ms: 1000,
        at: '2026-04-03T00:00:00.000Z',
      },
      db,
    );

    expect(await countAuditRows(db)).toBe(1);
    expect((await readRow(db, video))[0]).toMatchObject({
      decision: 'match',
      donor_id: donor.toHexString(),
      donor_lat: 1.5,
      at: '2026-04-03T00:00:00.000Z',
    });
  });
});

describe('listAuditedAssetIds', () => {
  test('is empty before the pass has judged anything', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(await listAuditedAssetIds(db)).toEqual([]);
    expect(await countAuditRows(db)).toBe(0);
  });

  test('returns every judged video as an ObjectId', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const videos = [videoId(), videoId()];

    for (const video of videos) {
      await recordAuditDecision(
        video,
        {
          maple_id: undefined,
          captured_at: '2026-04-01T10:00:00.000Z',
          decision: 'no-donor',
          at: '2026-04-02T00:00:00.000Z',
        },
        db,
      );
    }

    const audited = await listAuditedAssetIds(db);
    expect(audited.every((id) => id instanceof ObjectId)).toBe(true);
    expect(new Set(audited.map((id) => id.toHexString()))).toEqual(
      new Set(videos.map((id) => id.toHexString())),
    );
    expect(await countAuditRows(db)).toBe(2);
  });
});
