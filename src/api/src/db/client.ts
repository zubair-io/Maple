/**
 * MongoDB client singleton with lazy connection + graceful error reporting.
 *
 * Config via env:
 *   MAPLE_MONGO_URI  — connection string (default: mongodb://localhost:27017)
 *   MAPLE_MONGO_DB   — database name (default: maple)
 */

import {
  MongoClient,
  type Db,
  type Collection,
  ServerApiVersion,
} from "mongodb";
import { child as childLogger } from "../log.ts";
import { searchBlobUpdateExpression } from "../enrichment/search-blob.ts";
import { migrationApplied, recordMigration } from "./migrations.ts";
import type {
  FolderDoc,
  AssetDoc,
  GeocodeCacheDoc,
  IndexerTaskDoc,
  JobDoc,
  PersonDoc,
  StageHandlerDoc,
  UserDoc,
  CredentialDoc,
  InviteDoc,
  RefreshTokenDoc,
  ChallengeDoc,
  BackupSessionDoc,
  UploadSessionDoc,
  AssetChangeDoc,
  ServerStateDoc,
} from "./schema.ts";
import type { WorkerConfigDoc } from "../workers/worker-config.repo.ts";

const log = childLogger("db");

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

  const uri = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
  const dbName = process.env.MAPLE_MONGO_DB ?? "maple";

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
      await client.db("admin").command({ ping: 1 });
      log.info({ uri }, "connected to MongoDB");
      _client = client;
      _db = client.db(dbName);
      return _db;
    } catch (err) {
      _connectPromise = null; // allow retry
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[db] Cannot connect to MongoDB (${uri}): ${msg}\n` +
          `Tip: run "docker compose up -d mongo" from src/api/`,
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
  return (await getDb()).collection<FolderDoc>("folders");
}

export async function assetsCollection(): Promise<Collection<AssetDoc>> {
  return (await getDb()).collection<AssetDoc>("assets");
}

export async function geocodeCacheCollection(): Promise<
  Collection<GeocodeCacheDoc>
> {
  return (await getDb()).collection<GeocodeCacheDoc>("geocode_cache");
}

export async function indexerQueueCollection(): Promise<
  Collection<IndexerTaskDoc>
> {
  return (await getDb()).collection<IndexerTaskDoc>("indexer_queue");
}

export async function jobsCollection(): Promise<Collection<JobDoc>> {
  return (await getDb()).collection<JobDoc>("jobs");
}

export async function stageHandlersCollection(): Promise<
  Collection<StageHandlerDoc>
> {
  return (await getDb()).collection<StageHandlerDoc>("stage_handlers");
}

export async function usersCollection(): Promise<Collection<UserDoc>> {
  return (await getDb()).collection<UserDoc>("users");
}
export async function credentialsCollection(): Promise<
  Collection<CredentialDoc>
> {
  return (await getDb()).collection<CredentialDoc>("credentials");
}
export async function invitesCollection(): Promise<Collection<InviteDoc>> {
  return (await getDb()).collection<InviteDoc>("invites");
}
export async function refreshTokensCollection(): Promise<
  Collection<RefreshTokenDoc>
> {
  return (await getDb()).collection<RefreshTokenDoc>("refresh_tokens");
}
export async function challengesCollection(): Promise<
  Collection<ChallengeDoc>
> {
  return (await getDb()).collection<ChallengeDoc>("challenges");
}
export async function peopleCollection(): Promise<Collection<PersonDoc>> {
  return (await getDb()).collection<PersonDoc>("people");
}

export async function workerConfigCollection(): Promise<
  Collection<WorkerConfigDoc>
> {
  return (await getDb()).collection<WorkerConfigDoc>("worker_config");
}

export async function backupSessionsCollection(): Promise<
  Collection<BackupSessionDoc>
> {
  return (await getDb()).collection<BackupSessionDoc>("backup_sessions");
}

export async function uploadSessionsCollection(): Promise<
  Collection<UploadSessionDoc>
> {
  return (await getDb()).collection<UploadSessionDoc>("upload_sessions");
}

export async function assetChangesCollection(): Promise<
  Collection<AssetChangeDoc>
> {
  return (await getDb()).collection<AssetChangeDoc>("asset_changes");
}

export async function serverStateCollection(): Promise<
  Collection<ServerStateDoc>
> {
  return (await getDb()).collection<ServerStateDoc>("server_state");
}

/** Stage names whose claim-query indexes are created at startup. */
const WORKER_STAGE_NAMES = [
  "hash",
  "exif",
  "thumb",
  "preview",
  "face",
  "describe",
  "geocode",
  "meili",
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
  const existingIndexes = await db.collection("assets").indexes();
  const indexByName = new Map(
    existingIndexes.map((i) => [i.name as string, i]),
  );

  for (const name of WORKER_STAGE_NAMES) {
    const versionIndexName = `stage_${name}_version`;
    const existing = indexByName.get(versionIndexName);

    if (existing?.partialFilterExpression) {
      // Old spec with { dead: false } partial filter — drop it so MongoDB
      // won't reject the createIndex below as a spec conflict. The old filter
      // excluded docs where `dead` is missing, which caused collection scans
      // for freshly-indexed assets. The unconstrained index fixes that.
      try {
        await db.collection("assets").dropIndex(versionIndexName);
      } catch {
        // IndexNotFound is fine — another process may have already dropped it.
      }
    }
    // createIndex is a fast no-op when the index already exists with identical
    // options, so we always call it regardless of whether we just dropped.
    await db.collection("assets").createIndex(
      { [`stages.${name}.version`]: 1 },
      { name: versionIndexName },
    );

    // Tiny partial index on dead-lettered docs. Powers the dead-count branch
    // of GET /api/workers/status — countDocuments({ stages.<name>.dead: true })
    // becomes a count of index entries instead of a full collection scan.
    // The partial filter keeps the index size proportional to the (small)
    // set of dead docs, not the whole collection.
    await db.collection("assets").createIndex(
      { [`stages.${name}.dead`]: 1 },
      {
        name: `stage_${name}_dead`,
        partialFilterExpression: { [`stages.${name}.dead`]: true },
      },
    );
  }
}

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
  if (!(await migrationApplied(db, "exif-captured-year-month-backfill"))) {
    try {
      const res = await db.collection("assets").updateMany(
        {
          "exif.captured_at": { $ne: null, $exists: true },
          "exif.captured_year": { $exists: false },
        },
        [
          {
            $set: {
              "exif.captured_year": {
                $year: {
                  $dateFromString: {
                    dateString: "$exif.captured_at",
                    onError: null,
                    onNull: null,
                  },
                },
              },
              "exif.captured_month": {
                $month: {
                  $dateFromString: {
                    dateString: "$exif.captured_at",
                    onError: null,
                    onNull: null,
                  },
                },
              },
            },
          },
        ],
      );
      await recordMigration(
        db,
        "exif-captured-year-month-backfill",
        res.modifiedCount,
      );
      log.info(
        { rows: res.modifiedCount },
        "applied exif.captured_year/month backfill",
      );
    } catch (err) {
      // Log + continue — the index build below still works against rows
      // that have year/month from the indexer's per-file path, the perf
      // win just won't apply to legacy rows until they're re-indexed.
      // We intentionally do NOT record the migration on failure: the next
      // boot will retry, which is the right behaviour for transient errors.
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "captured_year/month backfill skipped",
      );
    }
  }

  // Reset describe-stage dead rows whose dead-letter reason was a vision
  // parser type mismatch on `is_screenshot` or `text_visible` — both were
  // tightened-then-relaxed by the tolerant-vision-parser change. The
  // parser now coerces the variants qwen2.5-vl actually emits, so these
  // rows can be re-attempted. One-shot, gated on `migrations`.
  if (!(await migrationApplied(db, "reset-describe-dead-vision-parse-2026-05-20"))) {
    try {
      const res = await db.collection("assets").updateMany(
        {
          "stages.describe.dead": true,
          "stages.describe.last_error": {
            $regex: "vision-parse\\[wrong-type:(is_screenshot|text_visible)\\]",
          },
        },
        {
          $set: {
            "stages.describe.dead": false,
            "stages.describe.attempts": 0,
            "stages.describe.last_error": null,
          },
        },
      );
      await recordMigration(
        db,
        "reset-describe-dead-vision-parse-2026-05-20",
        res.modifiedCount,
      );
      log.info(
        { rows: res.modifiedCount },
        "reset describe-stage dead rows with parse-error reasons",
      );
    } catch (err) {
      // Log + continue. Operators can also click "Retry dead" in the
      // Workers settings UI to recover. Not recording on failure leaves
      // the migration eligible for next boot.
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "describe dead-reset migration skipped",
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
  if (!(await migrationApplied(db, "reset-describe-dead-vision-parse-2026-05-21"))) {
    try {
      const enumFields = "scene_type|time_of_day|lighting|weather|composition|shot_type|indoor_outdoor";
      const nullableFields = "subjects|colors|notable_objects|time_of_day|scene_type|lighting|weather|mood|composition|shot_type|indoor_outdoor";
      const res = await db.collection("assets").updateMany(
        {
          "stages.describe.dead": true,
          "stages.describe.last_error": {
            $regex:
              `vision-parse\\[(bad-enum:(${enumFields})|wrong-type:(${nullableFields}))\\]`,
          },
        },
        {
          $set: {
            "stages.describe.dead": false,
            "stages.describe.attempts": 0,
            "stages.describe.last_error": null,
          },
        },
      );
      await recordMigration(
        db,
        "reset-describe-dead-vision-parse-2026-05-21",
        res.modifiedCount,
      );
      log.info(
        { rows: res.modifiedCount },
        "reset describe-stage dead rows with enum / null parse-error reasons",
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "describe enum-dead-reset migration skipped",
      );
    }
  }

  // folders: path is unique
  await db.collection("folders").createIndex({ path: 1 }, { unique: true });

  // assets: non-unique compound index on (folder_id, filename) for query
  // performance only. The uniqueness constraint was dropped — same-filename
  // collisions are legitimate (e.g. two devices uploading IMG_1234.jpg via
  // backup-ingest, or any re-upload whose content hashed to a different
  // `maple_id`). Content-level dedup happens via the unique `maple_id_1`
  // index; on-disk path collisions are guarded by the backup-ingest route.
  //
  // Migration: any pre-existing `folder_id_1_filename_1` carries the old
  // `unique: true` spec. Drop it before recreating with the new spec so
  // `createIndex` doesn't reject as `IndexOptionsConflict`. The
  // introspect-and-drop pattern mirrors `ensureStageIndexes` above. On a
  // fresh DB the `assets` collection doesn't exist yet — calling
  // `.indexes()` on a missing namespace throws `NamespaceNotFound`
  // (Mongo error 26). The migration check is a no-op in that case anyway
  // (no pre-existing index to drop), so swallow the error.
  let assetIndexes: { name?: unknown; unique?: unknown; partialFilterExpression?: unknown }[] = [];
  try {
    assetIndexes = (await db.collection("assets").indexes()) as typeof assetIndexes;
  } catch (err) {
    const code = (err as { code?: number } | null)?.code;
    if (code !== 26) throw err;
  }
  const existingFolderFilenameIdx = assetIndexes.find(
    (i) =>
      (i.name as string) === "folder_id_1_filename_1" &&
      ((i as { unique?: unknown }).unique === true ||
        (i as { partialFilterExpression?: unknown }).partialFilterExpression),
  );
  if (existingFolderFilenameIdx) {
    try {
      await db.collection("assets").dropIndex("folder_id_1_filename_1");
    } catch {
      // IndexNotFound is fine — another process may have already dropped.
    }
  }
  await db.collection("assets").createIndex({ folder_id: 1, filename: 1 });
  await db.collection("assets").createIndex({ mtime: 1 }, { sparse: true });
  await db.collection("assets").createIndex({ folder_id: 1 });

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
  await db.collection("assets").createIndex(
    { deleted_at: 1 },
    {
      name: "deleted_at_1",
      partialFilterExpression: { deleted_at: { $type: "string" } },
    },
  );

  // Search indexes — added with EXIF support. Captured-at sorts the default
  // result list (newest first); camera + lens cover the FE's facet dropdowns;
  // the text index over filename + abs_path lets the search route fall back
  // to $regex (no $text) without a sequential scan when there are
  // alphanumeric ranges/wildcards involved. Sparse where the field is
  // optional so old rows without EXIF don't bloat the index.
  await db
    .collection("assets")
    .createIndex({ "exif.captured_at": -1 }, { sparse: true });
  await db
    .collection("assets")
    .createIndex(
      { "exif.camera_make": 1, "exif.camera_model": 1 },
      { sparse: true },
    );
  await db
    .collection("assets")
    .createIndex({ "exif.lens": 1 }, { sparse: true });
  // Anchored-prefix regex on abs_path is used by /api/search?pathPrefix=...
  // (Timeline view). Without this index, every prefix query is a coll scan.
  await db.collection("assets").createIndex({ abs_path: 1 });
  // Compound index for the timeline buckets endpoint. Lets Mongo answer
  // `match abs_path prefix → group by year+month` from the index alone
  // (no fetch of doc bodies). The partialFilterExpression scopes it to
  // live + timed rows, which is the only use case — keeps the index
  // small even on libraries with many soft-deleted or untimed assets.
  await db.collection("assets").createIndex(
    {
      abs_path: 1,
      "exif.captured_year": -1,
      "exif.captured_month": -1,
    },
    {
      name: "abs_path_captured_year_month",
      partialFilterExpression: {
        deleted_at: null,
        "exif.captured_year": { $exists: true },
      },
    },
  );
  // Content-derived dedup key: `maple_id` is the 16-byte hash assigned by
  // the hash stage. Hot-path callers:
  //   - `src/routes/backup-ingest.ts` `findOne({ maple_id })` per upload
  //   - `src/indexer/images.repo.ts` `findAssetByMapleId`
  //   - `src/enrichment/meilisearch-client.ts` `find({ maple_id: { $in } })`
  // All three would COLLSCAN without an index. Unique because the hash is
  // unique by construction.
  //
  // Partial filter (NOT `sparse: true`): freshly-discovered skeleton rows
  // are inserted with `maple_id: null` explicitly (see
  // `src/workers/discover/index.ts` line 140 — `$setOnInsert: { maple_id: null }`).
  // `sparse: true` only excludes documents where the field is *absent*, not
  // where it's present with value `null`, so a `sparse` unique index would
  // collapse every null-maple-id skeleton row into a single key and reject
  // the second insert with E11000. `$type: "string"` narrows the index to
  // real hash values, which is exactly the set the unique constraint needs
  // to police.
  await db.collection("assets").createIndex(
    { maple_id: 1 },
    {
      name: "maple_id_1",
      unique: true,
      partialFilterExpression: { maple_id: { $type: "string" } },
    },
  );

  // Fast prefix index on filename for lowercase-anchored regex queries
  // ($regex: "^...") — the planner can use this when the pattern is a
  // simple prefix. The case-insensitive substring query in the search route
  // collation-folds and falls back to a collection scan; Phase 3's text
  // index sits on `place.search_blob` (Mongo allows only ONE text index per
  // collection, and the place search is the user-visible surface).
  await db.collection("assets").createIndex({ filename: 1 });

  // indexer_queue: status for fast pending-task lookups
  await db.collection("indexer_queue").createIndex({ status: 1 });

  // jobs (JobRunner) — claim filter is
  //   { status: "queued",
  //     $or: [ {locked_by: null}, {lease_expires_at: { $lt: now }} ] }
  // Also list-by-status for the GET /api/jobs route. The compound index
  // covers status + lease_expires_at; the kind/created_at index keeps the
  // list view stable when callers filter by kind.
  await db
    .collection("jobs")
    .createIndex(
      { status: 1, lease_expires_at: 1 },
      { name: "jobs_claim" },
    );
  await db
    .collection("jobs")
    .createIndex(
      { kind: 1, status: 1, created_at: -1 },
      { name: "jobs_list" },
    );

  // Geocode worker — claim query is:
  //   { exif.gps.lat: $ne null, enrichment.geocode.done_at: null,
  //     $or: [ {locked_by: null}, {lease_expires_at: { $lt: now }} ] }
  // The compound index covers the equality + range portion; sort by
  // captured_at takes the existing exif.captured_at index.
  // `docs/indexer-enrichment.md` §3.1.
  await db.collection("assets").createIndex(
    {
      "exif.gps.lat": 1,
      "enrichment.geocode.done_at": 1,
      "enrichment.geocode.locked_by": 1,
    },
    { name: "geocode_claim", sparse: true },
  );

  // geocode_cache: documents are keyed by quantised lat/lon so the _id is
  // already a unique index. Add a covering index on geocoder_version so the
  // §7.3 versioned-rerun bulk update can find stale entries quickly.
  await db
    .collection("geocode_cache")
    .createIndex({ geocoder_version: 1 }, { name: "geocoder_version" });

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
  if (!(await migrationApplied(db, "place-search-blob-backfill"))) {
    try {
      const res = await db.collection("assets").updateMany(
        {
          place: { $ne: null },
          $or: [
            { "place.search_blob": "" },
            { "place.search_blob": { $exists: false } },
          ],
        },
        [
          {
            $set: {
              "place.search_blob": {
                $let: {
                  vars: {
                    // Address values, lowercased. Concat into one string and
                    // split on whitespace so multi-word values ("New York")
                    // become individual tokens.
                    addressTokens: {
                      $reduce: {
                        input: [
                          "$place.address.house_number",
                          "$place.address.road",
                          "$place.address.neighbourhood",
                          "$place.address.suburb",
                          "$place.address.city",
                          "$place.address.town",
                          "$place.address.village",
                          "$place.address.county",
                          "$place.address.state",
                          "$place.address.state_code",
                          "$place.address.postcode",
                          "$place.address.country",
                          "$place.address.country_code",
                        ],
                        initialValue: [] as string[],
                        in: {
                          $concatArrays: [
                            "$$value",
                            {
                              $cond: [
                                { $ifNull: ["$$this", false] },
                                {
                                  $split: [{ $toLower: "$$this" }, " "],
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
                        input: { $ifNull: ["$place.pois", []] },
                        initialValue: [] as string[],
                        in: {
                          $concatArrays: [
                            "$$value",
                            { $split: [{ $toLower: "$$this.name" }, " "] },
                            { $split: [{ $toLower: "$$this.type" }, " "] },
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
                                $setUnion: [
                                  "$$addressTokens",
                                  "$$poiTokens",
                                ],
                              },
                              cond: { $gt: [{ $strLenCP: "$$this" }, 0] },
                            },
                          },
                          sortBy: 1,
                        },
                      },
                      initialValue: "",
                      in: {
                        $cond: [
                          { $eq: ["$$value", ""] },
                          "$$this",
                          { $concat: ["$$value", " ", "$$this"] },
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
      await recordMigration(db, "place-search-blob-backfill", res.modifiedCount);
      log.info(
        { rows: res.modifiedCount },
        "applied place.search_blob backfill",
      );
    } catch (err) {
      // Log + continue. The text index build below is independent — a
      // backfill failure means a few legacy rows stay un-indexed for the
      // text search, but freshly-geocoded assets still index correctly.
      // We intentionally do NOT record the migration on failure: the next
      // boot will retry, which is the right behaviour for transient errors.
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "place.search_blob backfill skipped",
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
  // Re-read `assetIndexes` to capture indexes created since the earlier
  // snapshot above (e.g. the `folder_id_1_filename_1` rebuild).
  const assetIndexesPostFolderRebuild = await db
    .collection("assets")
    .indexes()
    .catch((err: unknown) => {
      const code = (err as { code?: number } | null)?.code;
      if (code === 26) return [] as typeof assetIndexes;
      throw err;
    });
  const presentLegacyTextIndexes = new Set(
    assetIndexesPostFolderRebuild
      .map((i) => i.name as string | undefined)
      .filter((n): n is string => n != null),
  );
  for (const legacy of [
    "filename_abs_path_text",
    "place_search_blob_text",
  ]) {
    if (!presentLegacyTextIndexes.has(legacy)) continue;
    try {
      await db.collection("assets").dropIndex(legacy);
    } catch (err) {
      if (
        !(err instanceof Error) ||
        !/IndexNotFound|index not found/i.test(err.message)
      ) {
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
  if (!(await migrationApplied(db, "asset-search-blob-backfill"))) {
    try {
      const res = await db.collection("assets").updateMany(
        {
          $or: [
            { search_blob: { $exists: false } },
            { search_blob: "" },
            { search_blob: null },
          ],
          $and: [
            {
              $or: [
                { "place.search_blob": { $exists: true, $ne: "" } },
                { description: { $exists: true, $ne: null, $ne: "" } },
                { ocr_text: { $exists: true, $ne: null, $ne: "" } },
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
      await recordMigration(db, "asset-search-blob-backfill", res.modifiedCount);
      log.info(
        { rows: res.modifiedCount },
        "applied asset.search_blob backfill",
      );
    } catch (err) {
      // We intentionally do NOT record the migration on failure: the next
      // boot will retry, which is the right behaviour for transient errors.
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "asset.search_blob backfill skipped",
      );
    }
  }

  await db.collection("assets").createIndex(
    { search_blob: "text" },
    {
      name: "search_blob_text",
      default_language: "english",
      // Same partial-filter shape as the legacy `place_search_blob_text`
      // index: scoped to live rows with a non-empty unified blob so
      // libraries with many GPS-less assets don't bloat the index.
      // Mongo partial-index expressions only allow equality, $exists,
      // $type, $gt/$gte/$lt/$lte, and top-level $and — so we use
      // `search_blob: { $type: "string", $gt: "" }` which the planner
      // can satisfy via the index entries themselves.
      partialFilterExpression: {
        deleted_at: null,
        search_blob: { $type: "string", $gt: "" },
      },
    },
  );

  // Faceted browse compound index — for "country → state → city"
  // drill-down aggregations against `place.rollups`. `docs/indexer-enrichment.md`
  // §5.4. Sparse so assets without `place` don't bloat the index.
  await db
    .collection("assets")
    .createIndex(
      {
        "place.rollups.country_code": 1,
        "place.rollups.region": 1,
        "place.rollups.locality": 1,
      },
      { name: "place_rollups", sparse: true },
    );

  const users = await usersCollection();
  try {
    await users.dropIndex("email_1");
  } catch (err) {
    if (
      !(err instanceof Error) ||
      !/IndexNotFound|index not found/i.test(err.message)
    )
      throw err;
  }
  await users.createIndex(
    { email: 1 },
    { unique: true, collation: { locale: "en", strength: 2 } },
  );

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

  const challenges = await challengesCollection();
  await challenges.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

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
      collation: { locale: "en", strength: 2 },
      partialFilterExpression: { merged_into: null },
      name: "people_name_unique",
    },
  );
  // Speeds up `assignFaceToPerson` reverse lookups + the clustering job's
  // bulk centroid recompute.
  await people.createIndex({ merged_into: 1 }, { name: "people_merged" });

  // Multikey index on the asset face → person back-reference. Powers the
  // /api/people aggregation that counts faces per person ($unwind + $group)
  // and the /api/people/:id detail aggregation that pulls a person's face
  // tiles. Without it both run as collection scans, which is the bottleneck
  // on libraries with many faces.
  await db
    .collection("assets")
    .createIndex({ "faces.person_id": 1 }, { name: "assets_face_person_id" });

  // worker_config: unique index on stage name (the natural key).
  await db
    .collection("worker_config")
    .createIndex({ name: 1 }, { unique: true, name: "worker_config_name" });

  // backup_sessions: natural key — enforces upsert race-safety.
  await db.collection("backup_sessions").createIndex(
    { library_id: 1, device_id: 1 },
    { unique: true, name: "backup_sessions_library_device" },
  );

  // upload_sessions: resume key — unique per asset per device per library.
  await db.collection("upload_sessions").createIndex(
    { library_id: 1, device_id: 1, phasset_local_id: 1 },
    { unique: true, name: "upload_sessions_resume_key" },
  );

  // upload_sessions: TTL — abandoned uploads are swept by MongoDB after 7 days.
  await db.collection("upload_sessions").createIndex(
    { updated_at: 1 },
    { name: "upload_sessions_ttl", expireAfterSeconds: 7 * 24 * 3600 },
  );

  // upload_sessions: cross-device conflict lookup. Partial index over only
  // "open" sessions with a phasset_cloud_id — openOrResume probes this to
  // detect another device actively uploading the same iCloud photo.
  await db.collection("upload_sessions").createIndex(
    { library_id: 1, phasset_cloud_id: 1 },
    {
      name: "upload_sessions_cloud_id",
      partialFilterExpression: {
        state: "open",
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
    .collection("asset_changes")
    .createIndex({ cursor: 1 }, { unique: true, name: "asset_changes_cursor" });
  await db
    .collection("asset_changes")
    .createIndex({ asset_id: 1 }, { name: "asset_changes_asset" });
  await db
    .collection("asset_changes")
    .createIndex(
      { folder_id: 1, cursor: 1 },
      { name: "asset_changes_folder_cursor" },
    );

  await ensureStageIndexes(db);

  log.info("indexes ensured");
}

/** Gracefully close the connection (call on server shutdown). */
export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
    _connectPromise = null;
    log.info("connection closed");
  }
}
