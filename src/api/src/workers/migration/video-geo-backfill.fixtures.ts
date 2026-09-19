/**
 * Shared fixtures for the video-GPS-backfill migrations
 * (`audit-video-geo-backfill` + `apply-video-geo-backfill`).
 *
 * Both suites need the same shape: two registered libraries, videos with a
 * capture time and no GPS, and photos with GPS that a video may or may not be
 * allowed to borrow from. The "may not" cases are the interesting ones — a
 * different library, another video, an asset that already borrowed its own
 * coordinates — so the builders take exactly the knobs that decide them.
 *
 * Not a test file: the name does not match Bun's `*.test.ts` glob.
 */

import type { Database } from 'bun:sqlite';
import type { ObjectId } from '../../db/object-id.ts';
import { newObjectIdHex } from '../../db/object-id.ts';
import { toObjectId } from '../../db/repos/values.ts';
import { createLiveTestDatabase, insertFolder } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { seedAsset, seedLocation } from './migration.test-helpers.ts';

/** Two libraries, because same-library scoping is one of the rules under test. */
export interface GeoFixture extends Disposable {
  readonly db: Database;
  readonly libA: ObjectId;
  readonly libB: ObjectId;
}

export async function createGeoFixture(): Promise<GeoFixture> {
  const live = await createLiveTestDatabase();
  try {
    const libA = toObjectId(insertFolder(live.db, { path: '/libraries/a', slug: 'lib-a' }));
    const libB = toObjectId(insertFolder(live.db, { path: '/libraries/b', slug: 'lib-b' }));
    return { db: live.db, libA, libB, [Symbol.dispose]: () => live.close() };
  } catch (err) {
    live.close();
    throw err;
  }
}

const DEFAULT_CAPTURED_AT = '2019-05-18T17:45:35.000Z';

function exifFor(capturedAt: string | null, gps: { lat: number; lng: number } | null): object {
  return {
    captured_at: capturedAt,
    captured_year: capturedAt ? new Date(capturedAt).getUTCFullYear() : null,
    captured_month: capturedAt ? new Date(capturedAt).getUTCMonth() + 1 : null,
    camera_make: null,
    camera_model: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focal_length: null,
    gps,
  };
}

/** A video with a capture time and, by default, no GPS — the candidate shape. */
export function videoAsset(
  fixture: GeoFixture,
  opts: {
    id?: string;
    capturedAt?: string | null;
    gps?: { lat: number; lng: number } | null;
    libraryId?: ObjectId;
    filename?: string;
    backupLayoutVersion?: number;
    deletedAt?: string | null;
    missingSince?: string | null;
    geoBackfillSkipped?: 'no-donor' | 'skip' | null;
  } = {},
): string {
  const id = opts.id ?? newObjectIdHex();
  const capturedAt = opts.capturedAt === undefined ? DEFAULT_CAPTURED_AT : opts.capturedAt;
  seedAsset(fixture.db, {
    id,
    mapleId: id,
    mediaKind: 'video',
    exif: exifFor(capturedAt, opts.gps ?? null),
    backupLayoutVersion: opts.backupLayoutVersion ?? null,
    geoBackfillSkipped: opts.geoBackfillSkipped ?? null,
    stages: ['geocode'],
  });
  fixture.db.run(`UPDATE stage_state SET version = 2 WHERE asset_id = ? AND stage = 'geocode'`, [
    id,
  ]);
  seedLocation(fixture.db, {
    assetId: id,
    libraryId: opts.libraryId ?? fixture.libA,
    path: 'videos',
    filename: opts.filename ?? `clip_${id}.mp4`,
    deletedAt: opts.deletedAt ?? null,
    missingSince: opts.missingSince ?? null,
  });
  return id;
}

/** A photo with GPS — a donor, unless one of the exclusion rules applies. */
export function photoAsset(
  fixture: GeoFixture,
  opts: {
    id?: string;
    capturedAt?: string;
    gps?: { lat: number; lng: number };
    libraryId?: ObjectId;
    filename?: string;
    /** Present when this asset borrowed its own coordinates — never a donor. */
    geoInferred?: object;
    deletedAt?: string | null;
    missingSince?: string | null;
  } = {},
): string {
  const id = opts.id ?? newObjectIdHex();
  seedAsset(fixture.db, {
    id,
    mapleId: id,
    mediaKind: 'image',
    exif: exifFor(
      opts.capturedAt ?? DEFAULT_CAPTURED_AT,
      opts.gps ?? { lat: 37.7749, lng: -122.4194 },
    ),
    ...(opts.geoInferred === undefined ? {} : { geoInferred: opts.geoInferred }),
  });
  seedLocation(fixture.db, {
    assetId: id,
    libraryId: opts.libraryId ?? fixture.libA,
    path: 'photos',
    filename: opts.filename ?? `photo_${id}.jpg`,
    deletedAt: opts.deletedAt ?? null,
    missingSince: opts.missingSince ?? null,
  });
  return id;
}

/** One video's recorded audit verdict, or null when the pass has not reached it. */
export function auditRow(
  db: Database,
  assetId: string,
): {
  decision: string;
  donor_id: string | null;
  donor_lat: number | null;
  donor_lng: number | null;
  delta_ms: number | null;
  captured_at: string;
} | null {
  return db
    .query(
      `SELECT decision, donor_id, donor_lat, donor_lng, delta_ms, captured_at
         FROM video_geo_backfill_audit WHERE asset_id = ?`,
    )
    .get(assetId) as {
    decision: string;
    donor_id: string | null;
    donor_lat: number | null;
    donor_lng: number | null;
    delta_ms: number | null;
    captured_at: string;
  } | null;
}

/** How many verdicts have been recorded so far. */
export function auditCount(db: Database): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM video_geo_backfill_audit`).get() as { n: number };
  return row.n;
}

/** The GPS an asset currently carries, as the apply pass writes it. */
export function gpsOf(db: Database, assetId: string): { lat: number; lng: number } | null {
  const row = db
    .query(`SELECT gps_lat AS lat, gps_lng AS lng FROM assets WHERE id = ?`)
    .get(assetId) as { lat: number | null; lng: number | null } | null;
  if (row?.lat == null || row.lng == null) return null;
  return { lat: row.lat, lng: row.lng };
}

/** The provenance stamp a borrowed coordinate carries, or null. */
export function geoInferredOf(db: Database, assetId: string): Record<string, unknown> | null {
  const row = db.query(`SELECT geo_inferred FROM asset_detail WHERE asset_id = ?`).get(assetId) as {
    geo_inferred: string | null;
  } | null;
  return row?.geo_inferred == null
    ? null
    : (JSON.parse(row.geo_inferred) as Record<string, unknown>);
}
