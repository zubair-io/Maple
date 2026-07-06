/**
 * MongoDB client singleton with lazy connection + graceful error reporting.
 *
 * Config via env:
 *   MAPLE_MONGO_URI  — connection string (default: mongodb://localhost:27017)
 *   MAPLE_MONGO_DB   — database name (default: maple)
 */

import { MongoClient, type Db, type Collection, ServerApiVersion } from 'mongodb';
import { child as childLogger } from '../log.ts';
import { searchBlobUpdateExpression } from '../enrichment/search-blob.ts';
import {
  backfillFileinfo,
  backfillFolderSlugs,
  backfillPersonFaceCount,
  countAssetsMissingFileinfo,
  dropLegacyLocationFields,
  hardenFileinfoCompoundIndex,
  mergeDuplicateAssets,
  migrationApplied,
  recordMigration,
} from './migrations.ts';
import type {
  FolderDoc,
  AssetDoc,
  GeocodeCacheDoc,
  IndexerTaskDoc,
  JobDoc,
  ImportDoc,
  ImportFileDoc,
  DiscoverFrontierDoc,
  PersonDoc,
  StageHandlerDoc,
  UserDoc,
  CredentialDoc,
  InviteDoc,
  RefreshTokenDoc,
  ChallengeDoc,
  NativeAuthCodeDoc,
  LanHandoffCodeDoc,
  BackupSessionDoc,
  UploadSessionDoc,
  AssetChangeDoc,
  ServerStateDoc,
  MirrorQueueDoc,
  PresetDoc,
} from './schema.ts';
import type { WorkerConfigDoc } from '../workers/worker-config.repo.ts';

const log = childLogger('db');

// Singleton client; created once on first call to getDb().
let _client: MongoClient | null = null;
let _db: Db | null = null;
let _connectPromise: Promise<Db> | null = null;

/**
 * Returns a connected Db instance. Connects lazily on first call.
 * Throws a descriptive error if MongoDB is unreachable.
 *
 * MAPLE_MONGO_URI / MAPLE_MONGO_DB are read at connect time, not module load,
 * so tests that override them (e.g. search-route.test.ts) work even when
 * another test in the same bun process has already imported this module.
 */
export async function getDb(): Promise<Db> {
  if (_db) return _db;
  if (_connectPromise) return _connectPromise;

  const uri = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
  const dbName = process.env.MAPLE_MONGO_DB ?? 'maple';

  _connectPromise = (async () => {
    const client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: false,
        deprecationErrors: true,
      },
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000,
    });

    try {
      await client.connect();
      // Ping to verify the connection is live.
      await client.db('admin').command({ ping: 1 });
      log.info({ uri }, 'connected to MongoDB');
      _client = client;
      _db = client.db(dbName);
      return _db;
    } catch (err) {
      _connectPromise = null; // allow retry
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[db] Cannot connect to MongoDB (${uri}): ${msg}\n` +
          `Tip: run "docker compose up -d mongo" from src/api/`,
        { cause: err },
      );
    }
  })();

  return _connectPromise;
}

/** Whether a live DB connection is currently established. */
export function isDbConnected(): boolean {
  return _db !== null;
}

/** Typed collection helpers. */
export async function foldersCollection(): Promise<Collection<FolderDoc>> {
  return (await getDb()).collection<FolderDoc>('folders');
}

export async function assetsCollection(): Promise<Collection<AssetDoc>> {
  return (await getDb()).collection<AssetDoc>('assets');
}

export async function geocodeCacheCollection(): Promise<Collection<GeocodeCacheDoc>> {
  return (await getDb()).collection<GeocodeCacheDoc>('geocode_cache');
}

export async function indexerQueueCollection(): Promise<Collection<IndexerTaskDoc>> {
  return (await getDb()).collection<IndexerTaskDoc>('indexer_queue');
}

export async function jobsCollection(): Promise<Collection<JobDoc>> {
  return (await getDb()).collection<JobDoc>('jobs');
}

export async function importsCollection(): Promise<Collection<ImportDoc>> {
  return (await getDb()).collection<ImportDoc>('imports');
}

export async function importFilesCollection(): Promise<Collection<ImportFileDoc>> {
  return (await getDb()).collection<ImportFileDoc>('import_files');
}

export async function discoverFrontierCollection(): Promise<Collection<DiscoverFrontierDoc>> {
  return (await getDb()).collection<DiscoverFrontierDoc>('discover_frontier');
}

export async function stageHandlersCollection(): Promise<Collection<StageHandlerDoc>> {
  return (await getDb()).collection<StageHandlerDoc>('stage_handlers');
}

export async function usersCollection(): Promise<Collection<UserDoc>> {
  return (await getDb()).collection<UserDoc>('users');
}
export async function credentialsCollection(): Promise<Collection<CredentialDoc>> {
  return (await getDb()).collection<CredentialDoc>('credentials');
}
export async function invitesCollection(): Promise<Collection<InviteDoc>> {
  return (await getDb()).collection<InviteDoc>('invites');
}
export async function refreshTokensCollection(): Promise<Collection<RefreshTokenDoc>> {
  return (await getDb()).collection<RefreshTokenDoc>('refresh_tokens');
}
export async function challengesCollection(): Promise<Collection<ChallengeDoc>> {
  return (await getDb()).collection<ChallengeDoc>('challenges');
}
export async function nativeAuthCodesCollection(): Promise<Collection<NativeAuthCodeDoc>> {
  return (await getDb()).collection<NativeAuthCodeDoc>('native_auth_codes');
}
export async function lanHandoffCodesCollection(): Promise<Collection<LanHandoffCodeDoc>> {
  return (await getDb()).collection<LanHandoffCodeDoc>('lan_handoff_codes');
}
export async function peopleCollection(): Promise<Collection<PersonDoc>> {
  return (await getDb()).collection<PersonDoc>('people');
}

export async function workerConfigCollection(): Promise<Collection<WorkerConfigDoc>> {
  return (await getDb()).collection<WorkerConfigDoc>('worker_config');
}

export async function presetsCollection(): Promise<Collection<PresetDoc>> {
  return (await getDb()).collection<PresetDoc>('presets');
}

export async function backupSessionsCollection(): Promise<Collection<BackupSessionDoc>> {
  return (await getDb()).collection<BackupSessionDoc>('backup_sessions');
}

export async function uploadSessionsCollection(): Promise<Collection<UploadSessionDoc>> {
  return (await getDb()).collection<UploadSessionDoc>('upload_sessions');
}

export async function assetChangesCollection(): Promise<Collection<AssetChangeDoc>> {
  return (await getDb()).collection<AssetChangeDoc>('asset_changes');
}

export async function serverStateCollection(): Promise<Collection<ServerStateDoc>> {
  return (await getDb()).collection<ServerStateDoc>('server_state');
}

export async function mirrorQueueCollection(): Promise<Collection<MirrorQueueDoc>> {
  return (await getDb()).collection<MirrorQueueDoc>('mirror_queue');
}

/** Stage names whose claim-query indexes are created at startup.
 *
 * The `hash` stage was removed in the content-addressing migration (hashing
 * is now done inline by discover/backup-ingest), so its indexes are dropped
 * by the `drop-abs-path-2026-05-21` sentinel block in `ensureIndexes` and
 * never recreated here.
 *
 * The single `face` stage was split into `face-detect` + `face-embed`.
 * Like `hash`, the legacy `stage_face_version` / `stage_face_dead` indexes
 * are simply no longer recreated — they're harmless if left behind on a
 * deployed DB. */
const WORKER_STAGE_NAMES = [
  'exif',
  'thumb',
  'preview',
  'face-detect',
  'face-embed',
  'describe',
  'geocode',
  'meili',
] as const;

/**
 * Creates two indexes per stage:
 *
 *   1. `stage_<name>_version` — unconstrained index on `stages.<name>.version`.
 *      No partial filter, so it covers all documents including those where
 *      `dead` is absent (freshly-indexed assets). The claim query uses
 *      `dead: { $ne: true }`, which matches both `false` and missing; an old
 *      partial filter on `{ dead: false }` would have silently excluded the
 *      missing-field case and caused a collection scan for new assets.
 *      On deploys that still carry the old partial-filter version of this
 *      index, the function drops it before recreating — but only when the
 *      stored spec has a `partialFilterExpression`, to avoid an expensive
 *      drop+rebuild on every boot when the correct spec is already in place.
 *
 *   2. `stage_<name>_dead` — partial index on `stages.<name>.dead`, filtered
 *      to documents where that field is `true`. Powers the dead-count branch
 *      of GET /api/workers/status without scanning the full collection; kept
 *      small because dead-lettered docs are a small fraction of the total.
 *
 * Safe to call multiple times — createIndex is a no-op when the index already
 * exists with identical options. The conditional drop for the version index
 * avoids unnecessary rebuilds on every boot.
 */
export async function ensureStageIndexes(db: Db): Promise<void> {
  // One round-trip to read all existing index specs. We use this below to
  // decide whether any stage_<name>_version index needs to be dropped before
  // recreation (only when it still carries the old partialFilterExpression).
  const existingIndexes = await db.collection('assets').indexes();
  const indexByName = new Map(existingIndexes.map((i) => [i.name as string, i]));

  await Promise.all(
    WORKER_STAGE_NAMES.map(async (name) => {
      const versionIndexName = `stage_${name}_version`;
      const existing = indexByName.get(versionIndexName);

      if (existing?.partialFilterExpression) {
        // Old spec with { dead: false } partial filter — drop it so MongoDB
        // won't reject the createIndex below as a spec conflict. The old filter
        // excluded docs where `dead` is missing, which caused collection scans
        // for freshly-indexed assets. The unconstrained index fixes that.
        try {
          await db.collection('assets').dropIndex(versionIndexName);
        } catch {
          // IndexNotFound is fine — another process may have already dropped it.
        }
      }
      // createIndex is a fast no-op when the index already exists with identical
      // options, so we always call it regardless of whether we just dropped.
      await db
        .collection('assets')
        .createIndex({ [`stages.${name}.version`]: 1 }, { name: versionIndexName });

      // Tiny partial index on dead-lettered docs. Powers the dead-count branch
      // of GET /api/workers/status — countDocuments({ stages.<name>.dead: true })
      // becomes a count of index entries instead of a full collection scan.
      // The partial filter keeps the index size proportional to the (small)
      // set of dead docs, not the whole collection.
      await db.collection('assets').createIndex(
        { [`stages.${name}.dead`]: 1 },
        {
          name: `stage_${name}_dead`,
          partialFilterExpression: { [`stages.${name}.dead`]: true },
        },
      );
    }),
  );
}

/** `$set` payload used by every "reset describe stage dead-letters" migration.
 * Brings a dead-lettered row back to the un-attempted state so the next
 * poll-tick of the describe stage picks it up. */
const RESET_DESCRIBE_DEAD_SET = {
  'stages.describe.dead': false,
  'stages.describe.attempts': 0,
  'stages.describe.last_error': null,
} as const;

/**
 * Ensure all required indexes exist. Safe to call multiple times (idempotent).
 * Call this once at startup after a successful DB connection.
 */
export async function ensureIndexes(): Promise<void> {
  const db = await getDb();

  // Backfill exif.captured_year + exif.captured_month for any rows
  // indexed before the timeline-buckets perf change. Gated on the
  // `migrations` collection — the predicate alone is NOT enough to
  // make this cheap on subsequent boots: the planner's "match zero"
  // check still has to walk the `exif.captured_at: -1` index (309k
  // keys + docs = 3.6s / 1GB read in the user's library; see
  // mongod.log evidence in PR body). After the first successful boot
  // post-deploy this branch is skipped entirely.
  if (!(await migrationApplied(db, 'exif-captured-year-month-backfill'))) {
    try {
      const res = await db.collection('assets').updateMany(
        {
          'exif.captured_at': { $ne: null, $exists: true },
          'exif.captured_year': { $exists: false },
        },
        [
          {
            $set: {
              'exif.captured_year': {
                $year: {
                  $dateFromString: {
                    dateString: '$exif.captured_at',
                    onError: null,
                    onNull: null,
                  },
                },
              },
              'exif.captured_month': {
                $month: {
                  $dateFromString: {
                    dateString: '$exif.captured_at',
                    onError: null,
                    onNull: null,
                  },
                },
              },
            },
          },
        ],
      );
      await recordMigration(db, 'exif-captured-year-month-backfill', res.modifiedCount);
      log.info({ rows: res.modifiedCount }, 'applied exif.captured_year/month backfill');
    } catch (err) {
      // Log + continue — the index build below still works against rows
      // that have year/month from the indexer's per-file path, the perf
      // win just won't apply to legacy rows until they're re-indexed.
      // We intentionally do NOT record the migration on failure: the next
      // boot will retry, which is the right behaviour for transient errors.
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'captured_year/month backfill skipped',
      );
    }
  }

  // Repair pass for the timeline buckets/grid divergence. The timeline groups
  // months by the numeric `exif.captured_year`/`captured_month`, but the grid
  // fetches a month by the `exif.captured_at` string range. A row with
  // `captured_at` set but the numeric fields missing/null is therefore visible
  // to the grid yet absent from the bucket — so months undercount and a month
  // whose rows are ALL like that never renders. The original backfill above
  // only caught `captured_year: {$exists:false}` and silently retries on
  // failure (so a timeout on a large library could leave a permanent gap).
  // This re-runnable pass closes both holes: it matches null OR absent, and
  // runs under its own sentinel. `captured_at` is stored UTC-normalised
  // (`.toISOString()`), and `$year`/`$month` default to UTC, so the derived
  // values match both the indexer's `getUTC*` path and the grid's UTC range —
  // buckets and grid agree afterwards. Per-row `onError/onNull: null` keeps a
  // single malformed date from aborting the batch.
  if (!(await migrationApplied(db, 'repair-captured-year-month-2026-06-07'))) {
    try {
      const res = await db.collection('assets').updateMany(
        {
          'exif.captured_at': { $type: 'string' },
          // Either numeric field null/absent — they're written together by the
          // exif stage, but match both defensively so a half-populated row
          // (e.g. month grouped under `null`) can't slip through.
          $or: [
            { 'exif.captured_year': { $in: [null] } },
            { 'exif.captured_month': { $in: [null] } },
          ],
        },
        [
          {
            $set: {
              'exif.captured_year': {
                $year: {
                  $dateFromString: {
                    dateString: '$exif.captured_at',
                    onError: null,
                    onNull: null,
                  },
                },
              },
              'exif.captured_month': {
                $month: {
                  $dateFromString: {
                    dateString: '$exif.captured_at',
                    onError: null,
                    onNull: null,
                  },
                },
              },
            },
          },
        ],
      );
      await recordMigration(db, 'repair-captured-year-month-2026-06-07', res.modifiedCount);
      log.info(
        { rows: res.modifiedCount },
        'repaired captured_year/month gap (timeline buckets/grid divergence)',
      );
    } catch (err) {
      // Not recorded on failure → retried next boot, same as the original.
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'captured_year/month repair skipped',
      );
    }
  }

  // Reset describe-stage dead rows whose dead-letter reason was a vision
  // parser type mismatch on `is_screenshot` or `text_visible` — both were
  // tightened-then-relaxed by the tolerant-vision-parser change. The
  // parser now coerces the variants qwen2.5-vl actually emits, so these
  // rows can be re-attempted. One-shot, gated on `migrations`.
  if (!(await migrationApplied(db, 'reset-describe-dead-vision-parse-2026-05-20'))) {
    try {
      const res = await db.collection('assets').updateMany(
        {
          'stages.describe.dead': true,
          'stages.describe.last_error': {
            $regex: 'vision-parse\\[wrong-type:(is_screenshot|text_visible)\\]',
          },
        },
        { $set: RESET_DESCRIBE_DEAD_SET },
      );
      await recordMigration(db, 'reset-describe-dead-vision-parse-2026-05-20', res.modifiedCount);
      log.info(
        { rows: res.modifiedCount },
        'reset describe-stage dead rows with parse-error reasons',
      );
    } catch (err) {
      // Log + continue. Operators can also click "Retry dead" in the
      // Workers settings UI to recover. Not recording on failure leaves
      // the migration eligible for next boot.
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'describe dead-reset migration skipped',
      );
    }
  }

  // Reset describe-stage dead rows whose dead-letter reason was an enum
  // mismatch or a null-value rejection now handled by the tolerant
  // synonym maps + null-defaults. Covers the parse-error patterns this
  // PR specifically fixes — `bad-enum` on the seven constrained fields,
  // and `wrong-type` on the three array fields + the enum fields qwen
  // returns null for on featureless images. The closing `\]` keeps the
  // match anchored to the exact bracketed-reason form so unrelated
  // failure modes (e.g. `bad-enum:future_field`) don't get reset by
  // mistake. One-shot.
  if (!(await migrationApplied(db, 'reset-describe-dead-vision-parse-2026-05-21'))) {
    try {
      const enumFields = 'scene_type|time_of_day|lighting|weather|composition|shot_type';
      const nullableFields =
        'subjects|colors|notable_objects|time_of_day|scene_type|lighting|weather|mood|composition|shot_type';
      const res = await db.collection('assets').updateMany(
        {
          'stages.describe.dead': true,
          'stages.describe.last_error': {
            $regex: `vision-parse\\[(bad-enum:(${enumFields})|wrong-type:(${nullableFields}))\\]`,
          },
        },
        { $set: RESET_DESCRIBE_DEAD_SET },
      );
      await recordMigration(db, 'reset-describe-dead-vision-parse-2026-05-21', res.modifiedCount);
      log.info(
        { rows: res.modifiedCount },
        'reset describe-stage dead rows with enum / null parse-error reasons',
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'describe enum-dead-reset migration skipped',
      );
    }
  }

  // Reset describe-stage dead rows whose dead-letter reason was ANY vision
  // parse failure. The Ollama provider now sends a JSON Schema via the
  // `format` parameter, which constrains decoding so the model cannot emit
  // out-of-enum values, drop required fields, or produce malformed JSON
  // — every prior vision-parse[*] error class is structurally impossible
  // on Ollama 0.5+. Re-attempting these rows through the constrained path
  // should clear the dead-letter backlog. Match is broad (any `vision-parse[`
  // prefix) so the never-resolved `not-json` rows from #186 get picked up
  // alongside the `bad-enum` / `wrong-type` patterns the previous migration
  // covered. One-shot.
  if (!(await migrationApplied(db, 'reset-describe-dead-vision-parse-2026-05-22'))) {
    try {
      const res = await db.collection('assets').updateMany(
        {
          'stages.describe.dead': true,
          'stages.describe.last_error': { $regex: 'vision-parse\\[' },
        },
        { $set: RESET_DESCRIBE_DEAD_SET },
      );
      await recordMigration(db, 'reset-describe-dead-vision-parse-2026-05-22', res.modifiedCount);
      log.info(
        { rows: res.modifiedCount },
        'reset describe-stage dead rows for constrained-decoding retry',
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'describe constrained-decoding dead-reset migration skipped',
      );
    }
  }

  // folders: path is unique
  await db.collection('folders').createIndex({ path: 1 }, { unique: true });

  // Backfill `slug` on folders that pre-date M1, then create the unique
  // index — ordering matters: the index must be created after all rows have
  // a non-null slug so the createIndex call doesn't fail on null dupes.
  if (!(await migrationApplied(db, 'backfill-folder-slugs-2026-06-16'))) {
    // STOP on backfill failure: creating the unique slug index while rows still
    // carry null slugs produces a confusing DuplicateKey error (all nulls collide
    // on the unique constraint). If backfill fails, rethrow so boot halts with a
    // clear message rather than proceeding to an unrecoverable index-creation failure.
    const res = await backfillFolderSlugs(db);
    await recordMigration(db, 'backfill-folder-slugs-2026-06-16', res.updated);
    log.info(res, 'applied backfill-folder-slugs');
  }
  // Safe to create the unique index now — boot guarantees all rows have a slug
  // (either pre-existing or minted by the backfill above).
  await db
    .collection('folders')
    .createIndex({ slug: 1 }, { unique: true, sparse: true, name: 'folders_slug_unique' });

  // Populate `face_count` on every live person doc. Before this migration,
  // GET /api/people ran an O(total-faces) $unwind aggregation per request;
  // after it the hot path reads `person.face_count` directly. Non-blocking:
  // zeroed people (no faces yet) are set to 0 explicitly.
  if (!(await migrationApplied(db, 'backfill-person-face-count-2026-06-27'))) {
    const res = await backfillPersonFaceCount(db);
    await recordMigration(db, 'backfill-person-face-count-2026-06-27', res.updated + res.zeroed);
    log.info(res, 'applied backfill-person-face-count');
  }

  // assets: legacy compound + standalone indexes on `folder_id` / `filename`
  // were retired in the drop-abs-path-2026-05-21 migration below (see end of
  // this function). Replacement indexes live on `fileinfo.library_id` and
  // `(fileinfo.path, fileinfo.filename)`.
  await db.collection('assets').createIndex({ mtime: 1 }, { sparse: true });

  // Trash-GC sweeper queries `{ deleted_at: { $lt: cutoffIso, $ne: null } }`
  // every interval (and once on boot). Without this index the find is a
  // COLLSCAN across the whole assets collection (~430k rows in the user's
  // library = 1.4 GB / 3.85s per pass; see mongod.log evidence in PR body).
  //
  // Partial filter: live rows write `deleted_at: null` explicitly (see
  // `src/workers/discover/index.ts` lines 95 + 130 — every new asset gets
  // the field), so `$exists: true` would index the entire collection.
  // `$type: "string"` narrows the index to actual ISO-string values, i.e.
  // the small set of trashed rows that the GC actually iterates.
  await db.collection('assets').createIndex(
    { deleted_at: 1 },
    {
      name: 'deleted_at_1',
      partialFilterExpression: { deleted_at: { $type: 'string' } },
    },
  );

  // Missing-reaper sweeper queries
  //   { "fileinfo.missing_since": { $type: "string" } }
  // every interval (and /status counts the same set), and sorts on the same
  // key. `missing_since` moved from the asset root to per-`fileinfo` entry, so
  // this is a multikey partial index on the array sub-field. Same shape +
  // rationale as `deleted_at_1`: live entries carry `missing_since` absent/null,
  // so a `$type: "string"` partial filter narrows the index to just the (small)
  // set of rows with a tagged entry and keeps the scan O(tagged). The legacy
  // root-level `missing_since_1` index is dropped (the migration $unsets the
  // root field, leaving it indexing nothing).
  await db
    .collection('assets')
    .dropIndex('missing_since_1')
    .catch(() => {});
  await db.collection('assets').createIndex(
    { 'fileinfo.missing_since': 1 },
    {
      name: 'fileinfo_missing_since_1',
      partialFilterExpression: { 'fileinfo.missing_since': { $type: 'string' } },
    },
  );

  // Multi-location assets (the DeDuplicate worker's candidate set). Both the
  // worker's per-pass `find` and the /status pending count query
  //   { "fileinfo.1": { $exists: true } }
  // — i.e. "has a 2nd location" — which without an index is a COLLSCAN every
  // pass and every (2s-cached) /status refresh. A partial index whose filter is
  // exactly that predicate contains ONLY the (rare) duplicate-location rows, so
  // both queries become O(matches): the find seeks just those rows and the count
  // is answered by an index COUNT_SCAN. `$exists: true` is a supported partial
  // filter operator. Same narrow-partial pattern as `fileinfo_missing_since_1`.
  await db.collection('assets').createIndex(
    { 'fileinfo.1': 1 },
    {
      name: 'fileinfo_multi_location',
      partialFilterExpression: { 'fileinfo.1': { $exists: true } },
    },
  );

  // Partial index on `live_location_count` for the deduplicate status count
  // (#1302). The /status count switches from liveAwareDuplicatePredicate()'s
  // `$expr`+`$filter` FETCH scan to:
  //   countDocuments({ live_location_count: { $gte: 2 } })
  // which hits only the entries in this index (only assets with ≥2 live
  // locations) and returns an index COUNT_SCAN with zero per-row FETCH.
  // The partial filter `{ $gte: 2 }` keeps the index tiny (proportional to
  // the duplicate set, not the whole collection). Background to avoid blocking
  // on first deploy with a large existing collection.
  await db.collection('assets').createIndex(
    { live_location_count: 1 },
    {
      name: 'live_location_count_gte2',
      partialFilterExpression: { live_location_count: { $gte: 2 } },
      background: true,
    },
  );

  // Fold the legacy root-level `missing_since` tag down onto the row's
  // `fileinfo` entries (it moved per-location), then drop the root field.
  // Each entry inherits the root timestamp unless it already carries its own,
  // so the reaper's per-entry cooldown clock keeps the original age — an
  // already-aged orphan is still reaped promptly, not reset. Rows that were
  // root-tagged always had ≥1 fileinfo entry (the old tag paths required one),
  // so nothing is stranded. A pipeline `updateMany` does it in one pass;
  // one-shot, gated by the migrations sentinel. Live entries that get tagged
  // by mistake (a transient stage failure that had set root missing) self-heal
  // on the next reaper pass (re-stat → present → clear).
  if (!(await migrationApplied(db, 'migrate-missing-since-to-fileinfo-2026-06-05'))) {
    try {
      const folded = await db
        .collection('assets')
        .updateMany({ missing_since: { $type: 'string' } }, [
          {
            $set: {
              fileinfo: {
                $map: {
                  input: { $ifNull: ['$fileinfo', []] },
                  as: 'f',
                  in: {
                    $mergeObjects: [
                      '$$f',
                      { missing_since: { $ifNull: ['$$f.missing_since', '$missing_since'] } },
                    ],
                  },
                },
              },
            },
          },
          { $unset: 'missing_since' },
        ]);
      // Pre-existing orphans: rows whose every fileinfo entry is `deleted_at`
      // (content replaced in place) with NO live entry and NO entry already
      // tagged missing. Old code reaped these via the stage→root-missing_since
      // path; the new claim query parks no-live-entry rows, so without a tag
      // they would never be reaped. Dual-flag each entry `missing_since` (=
      // its `deleted_at`, preserving age) so the reaper prunes + deletes them.
      const orphans = await db.collection('assets').updateMany(
        {
          'fileinfo.0': { $exists: true },
          fileinfo: {
            $not: { $elemMatch: { deleted_at: { $in: [null] }, missing_since: { $in: [null] } } },
          },
          'fileinfo.missing_since': { $not: { $type: 'string' } },
        },
        [
          {
            $set: {
              fileinfo: {
                $map: {
                  input: '$fileinfo',
                  as: 'f',
                  in: {
                    $mergeObjects: [
                      '$$f',
                      { missing_since: { $ifNull: ['$$f.missing_since', '$$f.deleted_at'] } },
                    ],
                  },
                },
              },
            },
          },
        ],
      );
      await recordMigration(
        db,
        'migrate-missing-since-to-fileinfo-2026-06-05',
        folded.modifiedCount + orphans.modifiedCount,
      );
      log.info(
        { folded: folded.modifiedCount, orphans: orphans.modifiedCount },
        'migrated root missing_since → fileinfo[].missing_since (+ flagged pre-existing orphans)',
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'missing_since → fileinfo migration skipped',
      );
    }
  }

  // `damaged` tagging: the claim query excludes tagged rows on every tick
  //   { "damaged.since": { $not: { $type: "string" } } }
  // and /status + the damaged list count/iterate the tagged set
  //   { "damaged.since": { $type: "string" } }
  // Same shape + rationale as `missing_since_1`: live rows carry `damaged`
  // absent/null, so a `$type: "string"` partial filter narrows the index to
  // just the (small) set of tagged rows and keeps the scan O(tagged).
  await db.collection('assets').createIndex(
    { 'damaged.since': 1 },
    {
      name: 'damaged_since_1',
      partialFilterExpression: { 'damaged.since': { $type: 'string' } },
    },
  );

  // Search indexes — added with EXIF support. Captured-at sorts the default
  // result list (newest first); camera + lens cover the FE's facet dropdowns.
  // Sparse where the field is optional so old rows without EXIF don't bloat
  // the index. The former `abs_path_1` and `abs_path_captured_year_month`
  // indexes were retired by the drop-abs-path-2026-05-21 migration at the
  // end of this function; path-prefix and timeline queries now run against
  // `fileinfo.path`.
  await db.collection('assets').createIndex({ 'exif.captured_at': -1 }, { sparse: true });
  // Donor lookup for the apply-video-geo-backfill migration (#1529): the donor
  // query ranges on `exif.captured_at` (±15 min window) among GPS-bearing assets.
  // A `partialFilterExpression` on `exif.gps.lat` — NOT `sparse` — is what keeps
  // this index small: a SPARSE *compound* index includes a document that has ANY
  // of the keyed fields, so `exif.captured_at` (present on nearly every asset)
  // would drag almost the whole collection in. The partial filter indexes only
  // the GPS-bearing rows, so the donor query (which predicates on `exif.gps.lat`)
  // seeks the narrow time window within that subset.
  await db.collection('assets').createIndex(
    { 'exif.captured_at': 1, 'exif.gps.lat': 1 },
    {
      name: 'exif_captured_at_gps_lat',
      partialFilterExpression: { 'exif.gps.lat': { $exists: true } },
    },
  );
  await db
    .collection('assets')
    .createIndex({ 'exif.camera_make': 1, 'exif.camera_model': 1 }, { sparse: true });
  await db.collection('assets').createIndex({ 'exif.lens': 1 }, { sparse: true });
  // One-shot heal: collapse pre-existing rows sharing a maple_id into one
  // with a union fileinfo[]. Gated by the migrations sentinel so this runs
  // exactly once per database (subsequent boots short-circuit). MUST run
  // BEFORE the unique-partial `maple_id_gt_1` createIndex below — otherwise
  // createIndex would throw DuplicateKey on deploys carrying pre-existing
  // dupes and the boot would abort. See PR #234 / issue #233.
  if (!(await migrationApplied(db, 'merge-duplicate-assets-2026-05-21'))) {
    try {
      const res = await mergeDuplicateAssets(db);
      await recordMigration(db, 'merge-duplicate-assets-2026-05-21', res.deleted_rows);
      log.info(res, 'applied merge-duplicate-assets');
    } catch (err) {
      // Do NOT record on failure so the next boot retries. Do NOT rethrow —
      // the existing boot contract is "continue so the operator can SSH in".
      // Log as error (not warn) with the full err object: a "skipped" message
      // on a real failure makes the subsequent DuplicateKey from createIndex
      // look unexplained.
      log.error(
        {
          err:
            err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : err,
        },
        'merge-duplicate-assets failed — unique maple_id_gt_1 index creation may fail next',
      );
    }
  }

  // Final content-addressing migration step: drop the legacy
  // `abs_path` / `folder_id` / `filename` indexes once every live row has
  // `fileinfo` populated. Pre-flight counts rows still missing the field;
  // if any are found we log the count and leave the indexes intact so the
  // operator can re-run discover (which backfills) and re-deploy.
  //
  // Crucially we do NOT throw on a non-zero count — aborting the API boot
  // would lock the operator out of the very surface they need to diagnose
  // the issue. The sentinel is only recorded once the drop runs cleanly,
  // so subsequent boots will retry until the state is consistent.
  if (!(await migrationApplied(db, 'drop-abs-path-2026-05-21'))) {
    const missing = await countAssetsMissingFileinfo(db);
    if (missing > 0) {
      log.error(
        { missing },
        'cannot drop abs_path indexes: rows still missing fileinfo — run discover to backfill',
      );
    } else {
      // Drop legacy indexes (IndexNotFound is fine — already dropped or never existed).
      // The `stage_hash_*` pair is dropped here too: the hash stage was retired in
      // PR 7 (hashing moved inline into discover/backup-ingest), so the worker-stage
      // index loop no longer recreates them. Bundling the drop into this sentinel
      // means existing deploys lose their orphan indexes on the next boot and the
      // drop never repeats afterwards (the sentinel short-circuits everything).
      for (const name of [
        'abs_path_1',
        'abs_path_captured_year_month',
        'folder_id_1_filename_1',
        'folder_id_1',
        'filename_1',
        'stage_hash_version',
        'stage_hash_dead',
      ]) {
        try {
          await db.collection('assets').dropIndex(name);
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (!/IndexNotFound|index not found/i.test(msg)) throw err;
        }
      }
      // Add replacement indexes scoped to fileinfo[]. The dedicated
      // `fileinfo.filename` index powers the `name` sort on /api/search and
      // /api/folders/:id — the compound `(fileinfo.path, fileinfo.filename)`
      // index above can't satisfy a sort-only-on-filename query because its
      // first key is `path`.
      await db.collection('assets').createIndex({ 'fileinfo.library_id': 1 });
      await db.collection('assets').createIndex({ 'fileinfo.path': 1, 'fileinfo.filename': 1 });
      await db
        .collection('assets')
        .createIndex({ 'fileinfo.filename': 1 }, { name: 'fileinfo_filename_1' });
      await recordMigration(db, 'drop-abs-path-2026-05-21', 0);
      log.info(
        'dropped legacy abs_path / folder_id / filename / stage_hash indexes; added fileinfo replacements',
      );
    }
  }

  // Compound (library_id, path, filename) index for the M1 catalog-backed
  // browse: resolveAddress performs a point query on this triple to locate
  // an asset by its slug-relative path. Non-unique base index is always
  // created first; then Task 2b promotion to unique runs if zero violations.
  await db
    .collection('assets')
    .createIndex(
      { 'fileinfo.library_id': 1, 'fileinfo.path': 1, 'fileinfo.filename': 1 },
      { name: 'fileinfo_lib_path_name' },
    );

  // Task 2b: attempt to promote to a unique index. If violations exist,
  // logs them and leaves the non-unique index in place (STOP-and-report
  // per CLAUDE.md principle 6 — never silently skip).
  try {
    await hardenFileinfoCompoundIndex(db);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'fileinfo compound uniqueness hardening failed (non-unique index remains in place)',
    );
  }

  // Content-derived dedup key: `maple_id` is the 16-byte hash assigned by
  // the hash stage. Hot-path callers (every one of these would COLLSCAN
  // without an index):
  //   - `src/workers/discover/handle-event.ts` `findOne({ maple_id })` per discovered file
  //   - `src/routes/backup-ingest.ts` `findOne({ maple_id })` per upload
  //   - `src/indexer/images.repo.ts` `findAssetByMapleId`
  //   - `src/enrichment/meilisearch-client.ts` `find({ maple_id: { $in } })`
  // Unique because the hash is unique by construction.
  //
  // Partial filter is `{ maple_id: { $gt: '' } }`, NOT `{ $type: 'string' }`
  // (which is what the predecessor index `maple_id_1` carried — see the
  // post-swap drop guarded by `swap-maple-id-partial-filter-2026-05-23`
  // below). Reason: MongoDB's planner does not infer that a literal-string
  // equality predicate like `{ maple_id: 'abc' }` satisfies
  // `{ maple_id: { $type: 'string' } }`, so the index was excluded at
  // candidate selection and every dedup lookup went COLLSCAN. `$gt: ''`
  // is matched by literal-string equality (any non-empty string is
  // `> ''`), and excludes `null` / absent / numeric values by BSON
  // canonical-type ordering. Note: `$gt: ''` does NOT exclude every
  // non-string type — BSON types that sort *after* strings (objects,
  // arrays, BinData, ObjectId, Boolean, Date, …) would also match. Maple
  // writers never produce those for `maple_id` (it's always either `null`
  // on a skeleton row or a 32-char hex string on a hashed row), so in
  // practice the indexed set is identical to what `$type: 'string'`
  // captured. If a future writer ever stores a non-string maple_id the
  // unique constraint would still police it correctly; only the planner
  // hint is at risk.
  //
  // Partial filter (NOT `sparse: true`): freshly-discovered skeleton rows
  // are inserted with `maple_id: null` explicitly. `sparse: true` only
  // excludes documents where the field is *absent*, not where it's
  // present with value `null`, so a `sparse` unique index would collapse
  // every null-maple-id skeleton row into a single key and reject the
  // second insert with E11000.
  //
  // Index name is `maple_id_gt_1`, not `maple_id_1`, on purpose. MongoDB
  // rejects createIndex with the same name + different partialFilter
  // (`IndexOptionsConflict`, code 85), so we can't rebuild in place. The
  // boot order also matters: `ensureIndexes` runs in the background
  // *after* HTTP routes are live (see `src/index.ts:282`), so concurrent
  // `POST /api/backup-ingest` could land in any drop→createIndex window.
  // To avoid a uniqueness gap during the swap we build the new index
  // first (under the new name), then drop the old one — the unique
  // constraint is enforced by *some* index throughout. The
  // `swap-maple-id-partial-filter-2026-05-23` sentinel guards the drop
  // so we don't issue a redundant `IndexNotFound` on every subsequent
  // boot.
  await db.collection('assets').createIndex(
    { maple_id: 1 },
    {
      name: 'maple_id_gt_1',
      unique: true,
      partialFilterExpression: { maple_id: { $gt: '' } },
    },
  );
  if (!(await migrationApplied(db, 'swap-maple-id-partial-filter-2026-05-23'))) {
    try {
      await db.collection('assets').dropIndex('maple_id_1');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (!/IndexNotFound|index not found/i.test(msg)) throw err;
    }
    await recordMigration(db, 'swap-maple-id-partial-filter-2026-05-23', 0);
  }

  // Secondary content-dedup key: the discover handler falls back to
  // `findOne({ sha1_head })` when the maple_id lookup misses, so a
  // duplicate file discovered AFTER the canonical row's id has been
  // upgraded from fallback to primary form by the exif stage still
  // dedups into the existing row. Without this fallback the inserted
  // row would later trip E11000 when the exif stage tried to upgrade
  // it to the same primary id. See `workers/discover/handle-event.ts`
  // for the lookup; `workers/stages/exif.ts` carries the runtime merge
  // for already-inserted duplicates.
  //
  // Not unique — legacy rows may share sha1_head when they were created
  // before content-addressing was enforced. Sparse to skip rows missing
  // the field.
  await db
    .collection('assets')
    .createIndex({ sha1_head: 1 }, { name: 'sha1_head_1', sparse: true });

  // The Cloudflare R2 thumbnail-sync backfill was a one-off JobRunner job at
  // the time this index was added; it's since been replaced by the
  // `cf-thumb-sync` pipeline stage (`workers/stages/cf-thumb-sync.ts`),
  // whose claim query selects on `stages.cf-thumb-sync.version` — the same
  // generic, unindexed claim-query shape every other stage (geocode,
  // describe, meili, ...) already uses. Drop the now-unused index rather
  // than leave a stale one accumulating on every boot (see the `hash`
  // stage's removal for why an unconditional drop belongs here, not just a
  // deleted `createIndex` call).
  await db
    .collection('assets')
    .dropIndex('cf_thumb_pending')
    .catch(() => {});

  // Partial index for the one-time `refile-backups` cleanup migration: every tick
  // it counts and scans backup-origin assets not yet refiled
  // (`backup_layout_version != 3`). Scoping the index to `phasset_links.0`-exists
  // (verified to be honoured by the planner — the candidate query IXSCANs this)
  // confines that scan to the mobile-backup subset instead of the whole
  // collection, so the sweep can't stall the shared event loop on a large library.
  // Droppable once the cleanup has completed library-wide.
  await db.collection('assets').createIndex(
    { backup_layout_version: 1 },
    {
      name: 'backup_layout_version_partial',
      partialFilterExpression: { 'phasset_links.0': { $exists: true } },
    },
  );

  // Hidden-images feature: `hidden` is `false`/absent for the overwhelming
  // majority of assets, so this index is scoped (partialFilterExpression) to
  // `hidden: true` — it can only ever help queries that are themselves
  // looking FOR hidden assets, never the main browse/search route's default
  // `hidden: { $ne: true }` exclusion (no index can narrow a "give me
  // everything not in this small set" query the way it narrows "give me only
  // this small set"). The two hot callers this does help:
  //   - `workers/routes-status.ts`'s `newlyHiddenTotal` countDocuments,
  //     polled every `STATUS_CACHE_TTL_MS` — without this it's a full
  //     COLLSCAN on every tick.
  //   - `routes/photos.ts`'s `GET /api/photos/hidden` listing.
  // Both filter on `hidden: true` plus `hidden_ack`, so `hidden_ack` is
  // included in the compound key; `hidden_reason` isn't (low selectivity
  // once already narrowed to the hidden subset, and it would need a
  // multi-value $in-friendly key order that isn't worth the maintenance
  // cost here).
  await db
    .collection('assets')
    .createIndex(
      { hidden: 1, hidden_ack: 1 },
      { name: 'hidden_pending', partialFilterExpression: { hidden: true } },
    );

  // The former standalone `filename_1` index was retired by the
  // drop-abs-path-2026-05-21 migration at the end of this function;
  // filename queries now run against `fileinfo.filename`.

  // indexer_queue: status for fast pending-task lookups
  await db.collection('indexer_queue').createIndex({ status: 1 });

  // jobs (JobRunner) — claim filter is
  //   { status: "queued",
  //     $or: [ {locked_by: null}, {lease_expires_at: { $lt: now }} ] }
  // Also list-by-status for the GET /api/jobs route. The compound index
  // covers status + lease_expires_at; the kind/created_at index keeps the
  // list view stable when callers filter by kind.
  await db
    .collection('jobs')
    .createIndex({ status: 1, lease_expires_at: 1 }, { name: 'jobs_claim' });
  await db
    .collection('jobs')
    .createIndex({ kind: 1, status: 1, created_at: -1 }, { name: 'jobs_list' });

  // imports (ImportRunner, ticket #742) — same claim shape as jobs:
  //   { status: "pending"/"running",
  //     $or: [ {locked_by: null}, {lease_expires_at: { $lt: now }} ] }
  // Plus list-by-status for GET /api/imports (sorted newest-first).
  await db
    .collection('imports')
    .createIndex({ status: 1, lease_expires_at: 1 }, { name: 'imports_claim' });
  await db
    .collection('imports')
    .createIndex({ status: 1, created_at: -1 }, { name: 'imports_list' });

  // import_files: per-file rows for an import, split out of the `imports` doc
  // so a huge folder can't push a single document past MongoDB's 16 MiB limit.
  // `(import_id, idx)` is the natural key — unique so a re-scan/retry can't
  // duplicate a row, and it serves the worker's ordered scan + per-file
  // progress update (findOne/updateOne by {import_id, idx}).
  await db
    .collection('import_files')
    .createIndex({ import_id: 1, idx: 1 }, { unique: true, name: 'import_files_import_idx' });

  // discover_frontier: resumable directory-walk queue. The frontier lives in
  // Mongo so the sweep's memory is O(one directory), not O(tree).
  // `(folder_id, dir_path, sweep_gen)` is the natural key — unique so a
  // re-seed can't double-enqueue the same directory in the same sweep.
  await db
    .collection('discover_frontier')
    .createIndex(
      { folder_id: 1, dir_path: 1, sweep_gen: 1 },
      { unique: true, name: 'discover_frontier_key' },
    );
  // Claim query: free (or lease-expired) rows for the active generation, oldest first.
  await db
    .collection('discover_frontier')
    .createIndex(
      { folder_id: 1, sweep_gen: 1, claimed_at: 1, enqueued_at: 1 },
      { name: 'discover_frontier_claim' },
    );

  // Geocode worker — claim query is:
  //   { exif.gps.lat: $ne null, enrichment.geocode.done_at: null,
  //     $or: [ {locked_by: null}, {lease_expires_at: { $lt: now }} ] }
  // The compound index covers the equality + range portion; sort by
  // captured_at takes the existing exif.captured_at index.
  // `docs/indexer-enrichment.md` §3.1.
  await db.collection('assets').createIndex(
    {
      'exif.gps.lat': 1,
      'enrichment.geocode.done_at': 1,
      'enrichment.geocode.locked_by': 1,
    },
    { name: 'geocode_claim', sparse: true },
  );

  // geocode_cache: documents are keyed by quantised lat/lon so the _id is
  // already a unique index. Add a covering index on geocoder_version so the
  // §7.3 versioned-rerun bulk update can find stale entries quickly.
  await db
    .collection('geocode_cache')
    .createIndex({ geocoder_version: 1 }, { name: 'geocoder_version' });

  // ── Phase 3: search ──────────────────────────────────────────────────
  // `docs/indexer-enrichment.md` §5.

  // Backfill search_blob for assets the Phase 2 worker ran BEFORE this
  // Phase 3 code shipped. Those rows have a `place` document with
  // `search_blob: ""` (Phase 2 emitted an empty blob to keep the type
  // satisfied). Rebuild the blob from the existing address + POIs in a
  // single aggregation pipeline so we don't ship a one-shot script.
  //
  // Gated on the `migrations` collection — the previous "predicate is
  // narrow so subsequent runs are no-ops" reasoning is wrong: the
  // updateMany still has to scan the collection (no index on
  // `place.search_blob`, so it COLLSCANs 431k to confirm zero matches —
  // 0.6s per boot in the user's library). The sentinel skips the entire
  // round-trip after first success.
  //
  // We scope to live + place-bearing rows so the update doesn't churn
  // every soft-deleted or never-geocoded asset.
  if (!(await migrationApplied(db, 'place-search-blob-backfill'))) {
    try {
      const res = await db.collection('assets').updateMany(
        {
          place: { $ne: null },
          $or: [{ 'place.search_blob': '' }, { 'place.search_blob': { $exists: false } }],
        },
        [
          {
            $set: {
              'place.search_blob': {
                $let: {
                  vars: {
                    // Address values, lowercased. Concat into one string and
                    // split on whitespace so multi-word values ("New York")
                    // become individual tokens.
                    addressTokens: {
                      $reduce: {
                        input: [
                          '$place.address.house_number',
                          '$place.address.road',
                          '$place.address.neighbourhood',
                          '$place.address.suburb',
                          '$place.address.city',
                          '$place.address.town',
                          '$place.address.village',
                          '$place.address.county',
                          '$place.address.state',
                          '$place.address.state_code',
                          '$place.address.postcode',
                          '$place.address.country',
                          '$place.address.country_code',
                        ],
                        initialValue: [] as string[],
                        in: {
                          $concatArrays: [
                            '$$value',
                            {
                              $cond: [
                                { $ifNull: ['$$this', false] },
                                {
                                  $split: [{ $toLower: '$$this' }, ' '],
                                },
                                [],
                              ],
                            },
                          ],
                        },
                      },
                    },
                    poiTokens: {
                      $reduce: {
                        input: { $ifNull: ['$place.pois', []] },
                        initialValue: [] as string[],
                        in: {
                          $concatArrays: [
                            '$$value',
                            { $split: [{ $toLower: '$$this.name' }, ' '] },
                            { $split: [{ $toLower: '$$this.type' }, ' '] },
                          ],
                        },
                      },
                    },
                  },
                  in: {
                    $reduce: {
                      input: {
                        // Sort + dedup by hand: $setUnion gives us the
                        // dedup; $sortArray gives the deterministic order
                        // (matches the parser's `[...set].sort().join(" ")`).
                        $sortArray: {
                          input: {
                            $filter: {
                              input: {
                                $setUnion: ['$$addressTokens', '$$poiTokens'],
                              },
                              cond: { $gt: [{ $strLenCP: '$$this' }, 0] },
                            },
                          },
                          sortBy: 1,
                        },
                      },
                      initialValue: '',
                      in: {
                        $cond: [
                          { $eq: ['$$value', ''] },
                          '$$this',
                          { $concat: ['$$value', ' ', '$$this'] },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      );
      await recordMigration(db, 'place-search-blob-backfill', res.modifiedCount);
      log.info({ rows: res.modifiedCount }, 'applied place.search_blob backfill');
    } catch (err) {
      // Log + continue. The text index build below is independent — a
      // backfill failure means a few legacy rows stay un-indexed for the
      // text search, but freshly-geocoded assets still index correctly.
      // We intentionally do NOT record the migration on failure: the next
      // boot will retry, which is the right behaviour for transient errors.
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'place.search_blob backfill skipped',
      );
    }
  }

  // ── Phase 8: unified search_blob ─────────────────────────────────────
  // The text index moved off `place.search_blob` and onto the synthesised
  // top-level `asset.search_blob` field — this is the union of place +
  // description + ocr_text, recomputed atomically inside each worker's
  // `complete()` via the aggregation-pipeline `$set` form so the three
  // schedulers never race each other. Mongo allows ONE text index per
  // collection; the unified field is the single user-visible target.
  //
  // Drop both legacy text indexes from older deploys before creating
  // the new one — they're mutually exclusive (only one text index per
  // collection). On fresh deploys and on every boot after the first, the
  // legacy indexes are absent, so the unconditional dropIndex commands
  // here used to issue two no-op round-trips per boot (visible in
  // mongod.log as `dropIndexes: "filename_abs_path_text"` followed by
  // `dropIndexes: "place_search_blob_text"`). Introspect first so the
  // common case (already migrated) is silent.
  //
  // Read the current asset indexes to determine which legacy text indexes
  // are still present. On a fresh DB the `assets` collection doesn't exist
  // yet — calling `.indexes()` on a missing namespace throws
  // `NamespaceNotFound` (Mongo error 26); treat that as an empty list.
  type IndexShape = {
    name?: unknown;
    unique?: unknown;
    partialFilterExpression?: unknown;
  };
  const assetIndexesPostFolderRebuild: IndexShape[] = await db
    .collection('assets')
    .indexes()
    .catch((err: unknown) => {
      const code = (err as { code?: number } | null)?.code;
      if (code === 26) return [] as IndexShape[];
      throw err;
    });
  const presentLegacyTextIndexes = new Set(
    assetIndexesPostFolderRebuild
      .map((i) => i.name as string | undefined)
      .filter((n): n is string => n != null),
  );
  for (const legacy of ['filename_abs_path_text', 'place_search_blob_text']) {
    if (!presentLegacyTextIndexes.has(legacy)) continue;
    try {
      await db.collection('assets').dropIndex(legacy);
    } catch (err) {
      if (!(err instanceof Error) || !/IndexNotFound|index not found/i.test(err.message)) {
        throw err;
      }
    }
  }

  // One-shot backfill: rows that have a populated `place.search_blob`
  // (typical post-Phase-2 state) but an empty/missing top-level
  // `search_blob` get the unified field synthesised from whatever's on
  // the row. Skips rows whose unified blob is already non-empty so a
  // worker that already ran doesn't get clobbered.
  //
  // Gated on the `migrations` collection — see the captured_year/month
  // and place.search_blob backfills above for the rationale. The
  // predicate alone doesn't prevent a full collection scan to confirm
  // "match zero" on subsequent boots.
  if (!(await migrationApplied(db, 'asset-search-blob-backfill'))) {
    try {
      const res = await db.collection('assets').updateMany(
        {
          $or: [{ search_blob: { $exists: false } }, { search_blob: '' }, { search_blob: null }],
          $and: [
            {
              $or: [
                { 'place.search_blob': { $exists: true, $ne: '' } },
                { description: { $exists: true, $nin: [null, ''] } },
                { ocr_text: { $exists: true, $nin: [null, ''] } },
              ],
            },
          ],
        },
        // Reuse the same pipeline expression the workers use, so the
        // backfill produces a byte-identical blob to what each worker's
        // `complete()` would write next time it ran. No overrides — the
        // expression reads `place.search_blob`, `description`, and
        // `ocr_text` directly off the live row.
        [{ $set: { search_blob: searchBlobUpdateExpression() } }],
      );
      await recordMigration(db, 'asset-search-blob-backfill', res.modifiedCount);
      log.info({ rows: res.modifiedCount }, 'applied asset.search_blob backfill');
    } catch (err) {
      // We intentionally do NOT record the migration on failure: the next
      // boot will retry, which is the right behaviour for transient errors.
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'asset.search_blob backfill skipped',
      );
    }
  }

  await db.collection('assets').createIndex(
    { search_blob: 'text' },
    {
      name: 'search_blob_text',
      default_language: 'english',
      // Same partial-filter shape as the legacy `place_search_blob_text`
      // index: scoped to live rows with a non-empty unified blob so
      // libraries with many GPS-less assets don't bloat the index.
      // Mongo partial-index expressions only allow equality, $exists,
      // $type, $gt/$gte/$lt/$lte, and top-level $and — so we use
      // `search_blob: { $type: "string", $gt: "" }` which the planner
      // can satisfy via the index entries themselves.
      partialFilterExpression: {
        deleted_at: null,
        search_blob: { $type: 'string', $gt: '' },
      },
    },
  );

  // One-shot backfill: populate fileinfo[0] for legacy rows that pre-date
  // the content-addressing migration. See `.archived-plans/plans/2026-05-20-
  // content-addressed-assets.md` PR 1. Idempotent — gated by the migrations
  // sentinel so subsequent boots short-circuit.
  if (!(await migrationApplied(db, 'fileinfo-backfill-2026-05-20'))) {
    try {
      const res = await backfillFileinfo(db);
      await recordMigration(db, 'fileinfo-backfill-2026-05-20', res.updated);
      log.info(
        { scanned: res.scanned, updated: res.updated, skipped: res.skipped },
        'applied fileinfo backfill',
      );
    } catch (err) {
      // Do NOT record on failure so the next boot retries.
      log.warn({ err: err instanceof Error ? err.message : err }, 'fileinfo backfill skipped');
    }
  }

  // One-shot cleanup: $unset the retired location triple (abs_path / folder_id
  // / filename) and the never-read derived-cache paths (thumb_path /
  // preview_path) from rows already carrying `fileinfo[]`. The
  // content-addressing migration retired these in code — writers stopped
  // writing them, readers derive locations from `fileinfo[]` and recompute
  // cache paths from `(library root, fileinfo[0].path, maple_id)` — but only
  // dropped the legacy indexes, leaving the dead field VALUES on every
  // pre-cutover row. Runs AFTER the fileinfo backfill above so a row
  // backfilled this boot is cleaned in the same pass; scoped to fileinfo-
  // bearing rows so an un-backfilled legacy row keeps the only fields its
  // location could be rebuilt from. Gated by the migrations sentinel.
  if (!(await migrationApplied(db, 'drop-legacy-location-fields-2026-06-11'))) {
    try {
      const res = await dropLegacyLocationFields(db);
      await recordMigration(db, 'drop-legacy-location-fields-2026-06-11', res.cleared);
      log.info(
        { rows: res.cleared },
        'dropped retired abs_path/folder_id/filename/thumb_path/preview_path from fileinfo rows',
      );
    } catch (err) {
      // Do NOT record on failure so the next boot retries.
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'drop-legacy-location-fields cleanup skipped',
      );
    }
  }

  // Faceted browse compound index — for "country → state → city"
  // drill-down aggregations against `place.rollups`. `docs/indexer-enrichment.md`
  // §5.4. Sparse so assets without `place` don't bloat the index.
  await db.collection('assets').createIndex(
    {
      'place.rollups.country_code': 1,
      'place.rollups.region': 1,
      'place.rollups.locality': 1,
    },
    { name: 'place_rollups', sparse: true },
  );

  const users = await usersCollection();
  try {
    await users.dropIndex('email_1');
  } catch (err) {
    if (!(err instanceof Error) || !/IndexNotFound|index not found/i.test(err.message)) throw err;
  }
  await users.createIndex({ email: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

  const creds = await credentialsCollection();
  await creds.createIndex({ credential_id: 1 }, { unique: true });
  await creds.createIndex({ user_id: 1 });

  const invites = await invitesCollection();
  await invites.createIndex({ code: 1 }, { unique: true });
  await invites.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

  const refresh = await refreshTokensCollection();
  await refresh.createIndex({ token_hash: 1 }, { unique: true });
  await refresh.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  await refresh.createIndex({ user_id: 1 });
  // Rotation lineage (#858): family-scoped revoke + the grace re-mint's
  // family-liveness lookup (`{ family_id, revoked_at: null }`) both key on this.
  await refresh.createIndex({ family_id: 1 });

  const challenges = await challengesCollection();
  await challenges.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

  const nativeCodes = await nativeAuthCodesCollection();
  await nativeCodes.createIndex({ code_hash: 1 }, { unique: true });
  await nativeCodes.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

  const lanHandoffCodes = await lanHandoffCodesCollection();
  await lanHandoffCodes.createIndex({ code_hash: 1 }, { unique: true });
  await lanHandoffCodes.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

  // people: case-insensitive unique on `name` so a duplicate name is impossible
  // at the DB level. The `renamePerson` repo method merges before it would
  // ever hit this constraint; the index is the safety net for direct inserts.
  // Partial filter excludes merged rows so a person can be merged then their
  // name re-used (the merged row keeps `name` for audit, but is not unique).
  const people = await peopleCollection();
  await people.createIndex(
    { name: 1 },
    {
      unique: true,
      collation: { locale: 'en', strength: 2 },
      partialFilterExpression: { merged_into: null },
      name: 'people_name_unique',
    },
  );
  // Speeds up `assignFaceToPerson` reverse lookups + the clustering job's
  // bulk centroid recompute.
  await people.createIndex({ merged_into: 1 }, { name: 'people_merged' });

  // Multikey index on the asset face → person back-reference. Powers the
  // /api/people aggregation that counts faces per person ($unwind + $group)
  // and the /api/people/:id detail aggregation that pulls a person's face
  // tiles. Without it both run as collection scans, which is the bottleneck
  // on libraries with many faces.
  await db
    .collection('assets')
    .createIndex({ 'faces.person_id': 1 }, { name: 'assets_face_person_id' });

  // worker_config: unique index on stage name (the natural key).
  await db
    .collection('worker_config')
    .createIndex({ name: 1 }, { unique: true, name: 'worker_config_name' });

  // presets (#1115): case-insensitive unique on `name` so two user presets
  // can't collide. Same collation pattern as `people_name_unique`; the
  // route's duplicate check is the friendly 409, this index is the safety
  // net for direct inserts.
  await db
    .collection('presets')
    .createIndex(
      { name: 1 },
      { unique: true, collation: { locale: 'en', strength: 2 }, name: 'presets_name_unique' },
    );

  // backup_sessions: natural key — enforces upsert race-safety.
  await db
    .collection('backup_sessions')
    .createIndex(
      { library_id: 1, device_id: 1 },
      { unique: true, name: 'backup_sessions_library_device' },
    );

  // upload_sessions: resume key — unique per asset per device per library.
  await db
    .collection('upload_sessions')
    .createIndex(
      { library_id: 1, device_id: 1, phasset_local_id: 1 },
      { unique: true, name: 'upload_sessions_resume_key' },
    );

  // upload_sessions: TTL — abandoned uploads are swept by MongoDB after 7 days.
  await db
    .collection('upload_sessions')
    .createIndex(
      { updated_at: 1 },
      { name: 'upload_sessions_ttl', expireAfterSeconds: 7 * 24 * 3600 },
    );

  // upload_sessions: cross-device conflict lookup. Partial index over only
  // "open" sessions with a phasset_cloud_id — openOrResume probes this to
  // detect another device actively uploading the same iCloud photo.
  await db.collection('upload_sessions').createIndex(
    { library_id: 1, phasset_cloud_id: 1 },
    {
      name: 'upload_sessions_cloud_id',
      partialFilterExpression: {
        state: 'open',
        phasset_cloud_id: { $exists: true },
      },
    },
  );

  // asset_changes (Phase 5b — File Provider push channel). Cursor is the
  // primary key for the change feed; unique because allocateCursor's
  // $inc never repeats. Per-asset and per-folder indexes power the
  // "all changes affecting this asset/folder" lookup that future
  // diagnostic tooling might want.
  await db
    .collection('asset_changes')
    .createIndex({ cursor: 1 }, { unique: true, name: 'asset_changes_cursor' });
  await db
    .collection('asset_changes')
    .createIndex({ asset_id: 1 }, { name: 'asset_changes_asset' });
  await db
    .collection('asset_changes')
    .createIndex({ folder_id: 1, cursor: 1 }, { name: 'asset_changes_folder_cursor' });

  // mirror_queue: pending file copies to a backup/mirror root. `mirror_path` is
  // the natural key (one pending copy per destination) so re-detection and
  // repeated write-failures coalesce. The claim query is
  //   { dead: { $ne: true }, $or: [ {claimed_at: null}, {claimed_at: { $lt: now }} ] }
  // sorted by enqueued_at — the compound index covers it.
  await db
    .collection('mirror_queue')
    .createIndex({ mirror_path: 1 }, { unique: true, name: 'mirror_queue_path' });
  await db
    .collection('mirror_queue')
    .createIndex({ dead: 1, claimed_at: 1, enqueued_at: 1 }, { name: 'mirror_queue_claim' });

  await ensureStageIndexes(db);

  log.info('indexes ensured');
}

/** Gracefully close the connection (call on server shutdown). */
export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close(true);
    _client = null;
    _db = null;
    _connectPromise = null;
    log.info('connection closed');
  }
}
