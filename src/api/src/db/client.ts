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
import type {
  FolderDoc,
  AssetDoc,
  IndexerTaskDoc,
  UserDoc,
  CredentialDoc,
  InviteDoc,
  RefreshTokenDoc,
  ChallengeDoc,
} from "./schema.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const MONGO_DB = process.env.MAPLE_MONGO_DB ?? "maple";

// Singleton client; created once on first call to getDb().
let _client: MongoClient | null = null;
let _db: Db | null = null;
let _connectPromise: Promise<Db> | null = null;

/**
 * Returns a connected Db instance. Connects lazily on first call.
 * Throws a descriptive error if MongoDB is unreachable.
 */
export async function getDb(): Promise<Db> {
  if (_db) return _db;
  if (_connectPromise) return _connectPromise;

  _connectPromise = (async () => {
    const client = new MongoClient(MONGO_URI, {
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
      console.log("[db] connected to MongoDB at", MONGO_URI);
      _client = client;
      _db = client.db(MONGO_DB);
      return _db;
    } catch (err) {
      _connectPromise = null; // allow retry
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[db] Cannot connect to MongoDB (${MONGO_URI}): ${msg}\n` +
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

export async function indexerQueueCollection(): Promise<
  Collection<IndexerTaskDoc>
> {
  return (await getDb()).collection<IndexerTaskDoc>("indexer_queue");
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

/**
 * Ensure all required indexes exist. Safe to call multiple times (idempotent).
 * Call this once at startup after a successful DB connection.
 */
export async function ensureIndexes(): Promise<void> {
  const db = await getDb();

  // Backfill exif.captured_year + exif.captured_month for any rows
  // indexed before the timeline-buckets perf change. Idempotent: the
  // predicate filters to rows that have captured_at but no captured_year,
  // so on subsequent boots this matches zero docs and is a no-op. Runs
  // BEFORE the compound index creation so the index has data to cover
  // immediately (Mongo would build the index either way, but doing the
  // updates first means the index build sees fewer dirty pages).
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
    if (res.modifiedCount > 0) {
      console.log(
        `[db] backfilled exif.captured_year/month for ${res.modifiedCount} rows`,
      );
    }
  } catch (err) {
    // Log + continue — the index build below still works against rows
    // that have year/month from the indexer's per-file path, the perf
    // win just won't apply to legacy rows until they're re-indexed.
    console.warn(
      "[db] captured_year/month backfill skipped:",
      err instanceof Error ? err.message : err,
    );
  }

  // folders: path is unique
  await db.collection("folders").createIndex({ path: 1 }, { unique: true });

  // assets: unique per (folder_id, filename); secondary on mtime
  await db
    .collection("assets")
    .createIndex({ folder_id: 1, filename: 1 }, { unique: true });
  await db.collection("assets").createIndex({ mtime: 1 }, { sparse: true });
  await db.collection("assets").createIndex({ folder_id: 1 });

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
  // Fast prefix index on filename for lowercase-anchored regex queries
  // ($regex: "^...") — the planner can use this when the pattern is a
  // simple prefix. The case-insensitive substring query in the search route
  // collation-folds and falls back to a collection scan; the text index
  // below provides the indexed alternative.
  await db.collection("assets").createIndex({ filename: 1 });
  // Text index covers filename + abs_path. The search route prefers
  // $regex for substring queries (more permissive matching) but the text
  // index unblocks future ranked search and is cheap to maintain.
  await db
    .collection("assets")
    .createIndex(
      { filename: "text", abs_path: "text" },
      { name: "filename_abs_path_text", default_language: "none" },
    );

  // indexer_queue: status for fast pending-task lookups
  await db.collection("indexer_queue").createIndex({ status: 1 });

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

  console.log("[db] indexes ensured");
}

/** Gracefully close the connection (call on server shutdown). */
export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
    _connectPromise = null;
    console.log("[db] connection closed");
  }
}
