/**
 * Two entries, one file path, one row: who gets it (#3790).
 *
 * The end-to-end half of `plan/contested-locations.test.ts`. A library is
 * seeded in MongoDB with five addresses that two entries each claim, imported
 * for real, and the result read back — because the rule being right in
 * isolation is not the claim that matters. The claims that matter are that the
 * winner's row is the one the destination holds, that the LOSER's asset is
 * imported whole apart from that one location, and that verification agrees
 * rather than having to be loosened to let it through.
 *
 * Every contest is arranged so that insertion order would get it wrong: rows
 * are written `_id` ascending, and in each pair the asset that should lose is
 * the one with the lower id. Without the resolution the second insert trips
 * `asset_locations_lib_path_name`, and because a document's rows are one
 * transaction the whole winning asset is rejected — which is exactly what the
 * production library did, 3,478 times.
 *
 * Uses the throwaway mongod on :27077 and skip-passes without it, like every
 * other Mongo-backed suite here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { closeImportSession, openImportSession, runImportOn } from './run.ts';
import { connectTestMongo, TEST_MONGO_URI } from './seed.test-helpers.ts';
import type { ImportOptions, ImportReport, VerifyReport } from './types.ts';
import { verifyImport } from './verify.ts';

const DB_NAME = `maple_contested_locations_${process.pid}`;

const LIBRARY = new ObjectId('6a0000000000000000000000');

/**
 * The asset ids, paired loser-then-winner and ascending within each pair, so
 * the document that must lose is always the one written first.
 */
const ID = {
  tombstone: '6a0000010000000000000001',
  live: '6a0000020000000000000002',
  missing: '6a0000030000000000000003',
  present: '6a0000040000000000000004',
  trashed: '6a0000050000000000000005',
  kept: '6a0000060000000000000006',
  stale: '6a0000070000000000000007',
  fresh: '6a0000080000000000000008',
  oldTombstone: '6a0000090000000000000009',
  newTombstone: '6a00000a000000000000000a',
} as const;

function iso(day: number): string {
  return new Date(Date.UTC(2026, 0, day)).toISOString();
}

/** One asset carrying one location, plus whatever the contest needs. */
function asset(
  id: string,
  filename: string,
  entry: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: new ObjectId(id),
    fileinfo: [{ path: '2026/02', filename, library_id: LIBRARY, ...entry }],
    size: 1024,
    mtime: 1_767_225_600_000,
    rating: 4,
    flag: 0,
    color_label: '',
    indexed_at: iso(1),
    ...extra,
  };
}

async function seedContests(db: Db): Promise<void> {
  await db.collection('folders').insertOne({
    _id: LIBRARY,
    path: '/libraries/contested',
    slug: 'contested',
    label: 'Contested',
    last_scan: iso(1),
    file_count: 5,
    created_at: iso(1),
  } as never);

  await db.collection('assets').insertMany([
    // 1. The production shape: a tombstone sitting on an address a live entry
    //    later claimed. The tombstone's library_id is the hex STRING form of
    //    the same ObjectId the live entry carries, so this also proves the
    //    resolution normalises an address the way the mapper does — if it did
    //    not, the two would not be recognised as the same address at all and
    //    the live asset would be rejected.
    //    The loser keeps a second, uncontested location at ordinal 1.
    {
      ...asset(ID.tombstone, 'IMG_2325.JPG', { deleted_at: iso(9) }),
      fileinfo: [
        {
          path: '2026/02',
          filename: 'IMG_2325.JPG',
          library_id: LIBRARY.toHexString(),
          deleted_at: iso(9),
        },
        { path: '2026/02', filename: 'IMG_2325.ARW', library_id: LIBRARY },
      ],
    },
    asset(ID.live, 'IMG_2325.JPG', {}),

    // 2. Both untagged by `deleted_at`, but one file is no longer on disk.
    asset(ID.missing, 'IMG_3000.JPG', { missing_since: iso(9) }),
    asset(ID.present, 'IMG_3000.JPG', {}),

    // 3. Both entries live; one belongs to an asset in the trash. Indexed
    //    later than its rival, so recency alone would hand it the address.
    asset(ID.trashed, 'IMG_4000.JPG', {}, { deleted_at: iso(9), indexed_at: iso(20) }),
    asset(ID.kept, 'IMG_4000.JPG', {}, { indexed_at: iso(2) }),

    // 4. Genuinely two live assets on one path — the same bytes indexed twice.
    asset(ID.stale, 'IMG_5000.JPG', {}, { indexed_at: iso(2) }),
    asset(ID.fresh, 'IMG_5000.JPG', {}, { indexed_at: iso(20) }),

    // 5. Two tombstones, which the same ladder decides rather than a rule of
    //    their own.
    asset(ID.oldTombstone, 'IMG_6000.JPG', { deleted_at: iso(8) }, { indexed_at: iso(2) }),
    asset(ID.newTombstone, 'IMG_6000.JPG', { deleted_at: iso(9) }, { indexed_at: iso(20) }),
  ] as never);
}

let client: MongoClient | null = null;
let report: ImportReport | null = null;
let verified: VerifyReport | null = null;
let sqlitePath = '';
let workDir = '';

function open(): Database {
  return new Database(sqlitePath, { readonly: true });
}

interface LocationRow {
  asset_id: string;
  ordinal: number;
  path: string;
  filename: string;
}

/** Every row at one address, which the unique index allows at most one of. */
function holdersOf(filename: string): LocationRow[] {
  const db = open();
  const rows = db
    .query(
      `SELECT asset_id, ordinal, path, filename FROM asset_locations
        WHERE library_id = ? AND path = ? AND filename = ?`,
    )
    .all(LIBRARY.toHexString(), '2026/02', filename) as LocationRow[];
  db.close();
  return rows;
}

/** The asset row and what it carries, for "the loser survived" assertions. */
function assetRow(id: string): { id: string; rating: number; live_location_count: number } | null {
  const db = open();
  const row = db
    .query(`SELECT id, rating, live_location_count FROM assets WHERE id = ?`)
    .get(id) as { id: string; rating: number; live_location_count: number } | null;
  db.close();
  return row;
}

function stageCount(id: string): number {
  const db = open();
  const row = db.query(`SELECT COUNT(*) AS n FROM stage_state WHERE asset_id = ?`).get(id) as {
    n: number;
  };
  db.close();
  return row.n;
}

beforeAll(async () => {
  client = await connectTestMongo();
  if (client === null) return;
  const mongo = client.db(DB_NAME);
  await mongo.dropDatabase();
  await seedContests(mongo);

  workDir = mkdtempSync(join(tmpdir(), 'maple-contested-'));
  sqlitePath = join(workDir, 'maple.db');
  const options: ImportOptions = {
    mongoUri: TEST_MONGO_URI,
    mongoDb: DB_NAME,
    sqlitePath,
    batchSize: 3,
    changesWindow: 'all',
    verifySample: 50,
    restart: true,
  };
  const session = await openImportSession(options);
  try {
    report = await runImportOn(session, options);
    verified = await verifyImport(session.mongo, session.sqlite, options);
  } finally {
    await closeImportSession(session);
  }
}, 60_000);

afterAll(async () => {
  if (client !== null) {
    await client.db(DB_NAME).dropDatabase();
    await client.close();
  }
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

describe('two entries claiming one file path', () => {
  it('skip-passes without a throwaway mongod on :27077', () => {
    if (client === null) {
      expect(client).toBeNull();
      return;
    }
    expect(report).not.toBeNull();
  });

  /**
   * The load-bearing one. Before the resolution this rejected the live asset
   * outright — its rating, faces, description and stage history with it —
   * because the tombstone was created first and therefore inserted first.
   */
  it('gives the address to the live entry, not to the tombstone inserted first', () => {
    if (client === null) return;
    expect(holdersOf('IMG_2325.JPG')).toEqual([
      { asset_id: ID.live, ordinal: 0, path: '2026/02', filename: 'IMG_2325.JPG' },
    ]);
  });

  it('keeps the losing asset whole, minus that one location', () => {
    if (client === null) return;
    expect(assetRow(ID.tombstone)).toEqual({
      id: ID.tombstone,
      rating: 4,
      live_location_count: 1,
    });
    // Its other location is untouched, and keeps its position in the source
    // array rather than being renumbered into the released entry's place.
    expect(holdersOf('IMG_2325.ARW')).toEqual([
      { asset_id: ID.tombstone, ordinal: 1, path: '2026/02', filename: 'IMG_2325.ARW' },
    ]);
    // Nothing else about the document was lost either.
    expect(stageCount(ID.tombstone)).toBeGreaterThan(0);
  });

  it('prefers the entry still on disk to the one tagged missing', () => {
    if (client === null) return;
    expect(holdersOf('IMG_3000.JPG').map((row) => row.asset_id)).toEqual([ID.present]);
    expect(assetRow(ID.missing)?.id).toBe(ID.missing);
  });

  it('prefers a live asset to a soft-deleted one that was indexed later', () => {
    if (client === null) return;
    expect(holdersOf('IMG_4000.JPG').map((row) => row.asset_id)).toEqual([ID.kept]);
    expect(assetRow(ID.trashed)?.id).toBe(ID.trashed);
  });

  it('gives a live-against-live contest to the more recently indexed asset', () => {
    if (client === null) return;
    expect(holdersOf('IMG_5000.JPG').map((row) => row.asset_id)).toEqual([ID.fresh]);
    expect(assetRow(ID.stale)).toEqual({ id: ID.stale, rating: 4, live_location_count: 0 });
  });

  it('decides tombstone against tombstone on the same ladder', () => {
    if (client === null) return;
    expect(holdersOf('IMG_6000.JPG').map((row) => row.asset_id)).toEqual([ID.newTombstone]);
    expect(assetRow(ID.oldTombstone)?.id).toBe(ID.oldTombstone);
  });

  it('reports what it released and why', () => {
    if (client === null) return;
    expect(report?.contestedAddresses).toBe(5);
    // One per contest: the tombstone, the missing entry, the trashed asset's
    // entry, and — both on recency — the staler duplicate and the older of the
    // two tombstones.
    expect(report?.locationsReleased).toEqual({
      'entry-liveness': 1,
      'entry-presence': 1,
      'asset-liveness': 1,
      'index-recency': 2,
    });
  });

  /**
   * Nothing was rejected, so nothing was lost: the released rows are the only
   * difference between the source and the destination, and the verifier
   * accounts for them by asking the source how many distinct addresses it
   * names rather than by tolerating a gap.
   */
  it('imports every asset and verifies', () => {
    if (client === null || verified === null) return;
    expect(report?.rejects).toEqual([]);
    expect(verified.counts.filter((entry) => !entry.ok)).toEqual([]);
    expect(verified.fields.filter((entry) => !entry.ok)).toEqual([]);
    expect(verified.ok).toBe(true);

    const db = open();
    const locations = db.query(`SELECT COUNT(*) AS n FROM asset_locations`).get() as { n: number };
    const assets = db.query(`SELECT COUNT(*) AS n FROM assets`).get() as { n: number };
    db.close();
    // Eleven entries across ten assets, five of them released.
    expect(assets.n).toBe(10);
    expect(locations.n).toBe(6);
  });
});
