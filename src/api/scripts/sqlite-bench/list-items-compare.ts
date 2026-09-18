/**
 * Before and after for #3746, measured rather than argued.
 *
 * Builds the same synthetic library twice — once as MongoDB documents, once as
 * SQLite rows — and runs each repository's own `findListItems` against it, so
 * the numbers come out of the code that ships rather than out of hand-written
 * queries that resemble it. It then checks the two lookups the ticket calls
 * defects, by plan on both engines and by clock on both engines.
 *
 *   bun scripts/sqlite-bench/list-items-compare.ts            # 60,000 assets
 *   bun scripts/sqlite-bench/list-items-compare.ts 200000     # a bigger one
 *
 * Nothing here touches production. The Mongo side creates a uniquely-named
 * database and drops it when it finishes; the SQLite side writes a temporary
 * file and deletes it. Both generators are seeded, so a re-run reproduces the
 * same library. A Mongo instance is optional — without one, the SQLite half
 * still runs and the comparison rows say so.
 */

import { Database } from 'bun:sqlite';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIVE_LOCATION_COUNT_RECOMPUTE_SQL } from '../../src/db/sqlite/ddl/asset-locations.ts';
import { LIVE_ASSET_PREDICATE } from '../../src/db/sqlite/ddl/assets.ts';
import { SCHEMA_PRAGMAS } from '../../src/db/sqlite/ddl/index.ts';
import { ASSETS_FTS_REBUILD_SQL } from '../../src/db/sqlite/ddl/search.ts';
import { fromBunSqlite, runMigrations } from '../../src/db/sqlite/migrate.ts';
import { ALL_MIGRATIONS } from '../../src/db/sqlite/migrations/index.ts';
import { newObjectIdHex } from '../../src/db/sqlite/object-id.ts';
import { findListItems as mongoFindListItems } from '../../src/db/assets.repo.ts';
import { findListItems as sqliteFindListItems } from '../../src/db/sqlite/repos/assets.repo.ts';
import { testSqliteDb } from '../../src/db/sqlite/repos/assets.test-helpers.ts';
import { listItemsSql, locationsByAssetIdsSql } from '../../src/db/sqlite/repos/assets.sql.ts';
import { generateLibrary } from './generate.ts';
import { CAMERAS, LENSES, PLACES, SCENES, skewedIndex, words } from './fixtures.ts';

const DEFAULT_ASSETS = 60_000;
const PAGE = 1000;
const RUNS = 5;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function timed<T>(runs: number, fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const samples: number[] = [];
  let value = await fn();
  for (let i = 0; i < runs; i += 1) {
    const startedAt = performance.now();
    value = await fn();
    samples.push(performance.now() - startedAt);
  }
  return { ms: median(samples), value };
}

function kb(bytes: number): string {
  return bytes < 1_000_000
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1_048_576).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// SQLite side
// ---------------------------------------------------------------------------

interface SqliteLibrary {
  db: Database;
  directory: string;
  libraryId: string;
}

async function buildSqlite(assetCount: number): Promise<SqliteLibrary> {
  const directory = mkdtempSync(join(tmpdir(), 'maple-listcompare-'));
  const db = new Database(join(directory, 'maple.sqlite'));
  for (const pragma of SCHEMA_PRAGMAS) db.exec(pragma);
  await runMigrations(fromBunSqlite(db), ALL_MIGRATIONS);
  generateLibrary(db, { assetCount });
  db.exec(LIVE_LOCATION_COUNT_RECOMPUTE_SQL);
  db.exec(ASSETS_FTS_REBUILD_SQL);
  db.exec('ANALYZE');
  const libraryId = (db.query(`SELECT id FROM folders LIMIT 1`).get() as { id: string }).id;
  return { db, directory, libraryId };
}

/** Bytes the database hands the process for one page, before any transform. */
function sqlitePageBytes(db: Database, pageSize: number): number {
  const rows = db.query(listItemsSql([], true)).all(pageSize) as Array<{ id: string }>;
  const ids = rows.map((row) => row.id);
  const locations = db.query(locationsByAssetIdsSql(ids.length)).all(...ids);
  return JSON.stringify(rows).length + JSON.stringify(locations).length;
}

// ---------------------------------------------------------------------------
// Mongo side
// ---------------------------------------------------------------------------

/**
 * One asset document, shaped like production rather than like a fixture.
 *
 * The size is the point: production documents average 8 KB because of the
 * vision payload, the transcript and the face embeddings, and those are
 * exactly the fields `findListItems` fetches and then throws away.
 */
function mongoDocument(index: number, libraryId: ObjectId, random: () => number): object {
  const [make, model] = CAMERAS[skewedIndex(random, CAMERAS.length)]!;
  const [countryCode, region, locality] = PLACES[skewedIndex(random, PLACES.length)]!;
  const captured = new Date(Date.UTC(2019 + (index % 7), index % 12, (index % 27) + 1));
  const hasVision = random() < 0.8;
  const faces = Array.from({ length: random() < 0.4 ? 2 : 0 }, () => ({
    bbox: { x: random(), y: random(), w: 0.2, h: 0.2 },
    person_id: null,
    confidence: 0.9,
    // A 512-float ArcFace vector, which is most of what makes a face row big.
    embedding: Array.from({ length: 512 }, () => Math.round(random() * 1e6) / 1e6),
    embedding_version: 'arcface_r100_glint360k_v1',
  }));
  return {
    _id: new ObjectId(),
    fileinfo: [
      {
        path: `${2019 + (index % 7)}/${String((index % 12) + 1).padStart(2, '0')}`,
        filename: `IMG_${String(index).padStart(7, '0')}.dng`,
        library_id: libraryId,
        deleted_at: null,
      },
    ],
    size: 40_000_000 + index,
    mtime: captured.getTime(),
    rating: Math.floor(random() * 6),
    flag: 0,
    color_label: '',
    has_xmp: random() < 0.35,
    sidecar_ver: 0,
    hidden: false,
    hidden_ack: false,
    is_screenshot: random() < 0.08,
    indexed_at: captured.toISOString(),
    live_location_count: 1,
    deleted_at: null,
    exif: {
      captured_at: captured.toISOString(),
      captured_year: captured.getUTCFullYear(),
      captured_month: captured.getUTCMonth() + 1,
      camera_make: make,
      camera_model: model,
      lens: LENSES[skewedIndex(random, LENSES.length)],
      iso: [100, 200, 400, 800, 1600][Math.floor(random() * 5)],
      gps: { lat: 40 + random(), lng: -74 + random() },
    },
    place: {
      source: 'nominatim',
      geocoder_version: 3,
      rollups: { locality, region, country_code: countryCode },
      search_blob: `${locality} ${region}`.toLowerCase(),
    },
    vision: hasVision
      ? {
          caption: words(random, 40),
          tags: Array.from({ length: 12 }, () => words(random, 1)),
          subjects: Array.from({ length: 6 }, () => words(random, 1)),
          setting: words(random, 2),
          scene_type: SCENES[Math.floor(random() * SCENES.length)],
          notable_objects: Array.from({ length: 8 }, () => words(random, 2)),
          text_visible: words(random, 30),
        }
      : null,
    description: hasVision ? words(random, 40) : null,
    ocr_text: hasVision ? words(random, 30) : null,
    transcript: random() < 0.1 ? { text: words(random, 400), language: 'en' } : null,
    faces,
    search_blob: words(random, 60),
    stages: Object.fromEntries(
      ['exif', 'thumb', 'preview', 'describe', 'geocode', 'meili'].map((stage) => [
        stage,
        { version: 1, attempts: 0, dead: false, processed_at: captured.toISOString() },
      ]),
    ),
    phasset_links:
      random() < 0.5
        ? [
            {
              device_id: `device-${index % 4}`,
              phasset_local_id: `${newObjectIdHex()}/L0/001`,
              first_seen: captured.toISOString(),
            },
          ]
        : [],
  };
}

/** A seeded PRNG, so the Mongo library reproduces like the SQLite one. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The indexes production carries for these two query shapes. */
async function buildMongo(db: Db, assetCount: number): Promise<ObjectId> {
  const libraryId = new ObjectId();
  await db.collection('folders').insertOne({ _id: libraryId, path: '/libraries/bench' } as never);
  const assets = db.collection('assets');
  const random = makeRandom(0x5eed);
  const batch: object[] = [];
  for (let i = 0; i < assetCount; i += 1) {
    batch.push(mongoDocument(i, libraryId, random));
    if (batch.length === 5000) {
      await assets.insertMany(batch as never[]);
      batch.length = 0;
    }
  }
  if (batch.length > 0) await assets.insertMany(batch as never[]);
  await assets.createIndex({ deleted_at: 1 }, { partialFilterExpression: { deleted_at: null } });
  await assets.createIndex({ 'fileinfo.library_id': 1, 'exif.captured_at': -1, _id: 1 });
  return libraryId;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const assetCount = Number.parseInt(process.argv[2] ?? '', 10) || DEFAULT_ASSETS;
  console.log(`#3746 — findListItems before/after, ${assetCount.toLocaleString()} assets\n`);

  const sqlite = await buildSqlite(assetCount);
  const sqliteHandle = testSqliteDb(sqlite.db);
  const sqlitePage = await timed(RUNS, () =>
    sqliteFindListItems({ liveOnly: true }, PAGE, sqliteHandle),
  );
  const sqliteFetched = sqlitePageBytes(sqlite.db, PAGE);

  let mongoClient: MongoClient | null = null;
  let mongoRow = 'mongodb unavailable — skipped';
  let mongoLookupRow = 'mongodb unavailable — skipped';
  try {
    mongoClient = await MongoClient.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
    const dbName = `maple_listcompare_${Date.now()}`;
    const mongoDb = mongoClient.db(dbName);
    await buildMongo(mongoDb, assetCount);

    const mongoPage = await timed(RUNS, () =>
      mongoFindListItems({ liveOnly: true }, PAGE, mongoDb),
    );
    const fetched = await mongoDb
      .collection('assets')
      .find({ deleted_at: null })
      .limit(PAGE)
      .toArray();
    mongoRow = `${mongoPage.ms.toFixed(1)} ms | fetched ${kb(JSON.stringify(fetched).length)} | DTO ${kb(
      JSON.stringify(mongoPage.value).length,
    )}`;

    const explain = await mongoDb
      .collection('assets')
      .find({
        'phasset_links.device_id': 'device-1',
        'phasset_links.phasset_local_id': 'no-such-id',
      })
      .explain('executionStats');
    const stats = (
      explain as { executionStats: { executionTimeMillis: number; totalDocsExamined: number } }
    ).executionStats;
    const stage = JSON.stringify(explain).includes('"COLLSCAN"') ? 'COLLSCAN' : 'indexed';
    mongoLookupRow = `${stage}, ${stats.totalDocsExamined.toLocaleString()} docs examined, ${stats.executionTimeMillis} ms`;

    await mongoDb.dropDatabase();
  } catch (err) {
    console.log(`  (mongo half skipped: ${err instanceof Error ? err.message : String(err)})\n`);
  } finally {
    await mongoClient?.close();
  }

  const sqlitePlan = (sql: string, ...params: unknown[]): string =>
    (
      sqlite.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{
        detail: string;
      }>
    )
      .map((row) => row.detail)
      .join(' / ');

  const lookupSql = `SELECT p.asset_id FROM asset_phasset_links p
     WHERE p.device_id = ? AND p.phasset_local_id = ?
       AND EXISTS (SELECT 1 FROM asset_locations l
                    WHERE l.asset_id = p.asset_id AND l.library_id = ? AND l.deleted_at IS NULL)
     LIMIT 1`;
  const lookup = await timed(RUNS, async () =>
    sqlite.db.query(lookupSql).all('device-1', 'no-such-id', sqlite.libraryId),
  );

  // The shape the schema doc calls load-bearing, against the shape it warns
  // about: same result, same data, one planner decision apart.
  const semiJoin = `SELECT a.id FROM assets a INDEXED BY assets_live_captured
     WHERE a.${LIVE_ASSET_PREDICATE}
       AND EXISTS (SELECT 1 FROM asset_locations l
                    WHERE l.asset_id = a.id AND l.ordinal = 0 AND l.library_id = ?)
     ORDER BY a.captured_at DESC, a.id LIMIT 200`;
  const innerJoin = `SELECT a.id FROM assets a
       JOIN asset_locations l ON l.asset_id = a.id AND l.ordinal = 0
     WHERE a.${LIVE_ASSET_PREDICATE} AND l.library_id = ?
     ORDER BY a.captured_at DESC, a.id LIMIT 200`;
  const semi = await timed(RUNS, async () => sqlite.db.query(semiJoin).all(sqlite.libraryId));
  const inner = await timed(RUNS, async () => sqlite.db.query(innerJoin).all(sqlite.libraryId));

  console.log(`findListItems, ${PAGE} rows`);
  console.log(`  mongo   ${mongoRow}`);
  console.log(
    `  sqlite  ${sqlitePage.ms.toFixed(1)} ms | fetched ${kb(sqliteFetched)} | DTO ${kb(
      JSON.stringify(sqlitePage.value).length,
    )}`,
  );

  console.log(`\nbackup-sidecar fallback lookup`);
  console.log(`  mongo   ${mongoLookupRow}`);
  console.log(`  sqlite  ${lookup.ms.toFixed(3)} ms`);
  console.log(`          ${sqlitePlan(lookupSql, 'device-1', 'no-such-id', sqlite.libraryId)}`);

  console.log(`\ngrid page by library and date, 200 rows`);
  console.log(`  semi-join   ${semi.ms.toFixed(2)} ms — ${sqlitePlan(semiJoin, sqlite.libraryId)}`);
  console.log(
    `  inner join  ${inner.ms.toFixed(2)} ms — ${sqlitePlan(innerJoin, sqlite.libraryId)}`,
  );

  sqlite.db.close();
  rmSync(sqlite.directory, { recursive: true, force: true });
}

await main();
