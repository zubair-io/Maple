/**
 * Cursor allocation + change-row writes for the asset change feed
 * (Phase 5b — File Provider push channel).
 *
 * The cursor is allocated via $inc on a single `server_state` doc; Mongo
 * guarantees per-doc atomicity so concurrent writers never collide.
 *
 * Change-row writes are best-effort: if the insert fails after the
 * cursor was allocated, the cursor gap is harmless. Clients tolerate
 * gaps via the cursor-too-old 409 path which triggers full re-enumeration.
 */

import { ObjectId, type Db } from "mongodb";
import {
  assetChangesCollection,
  foldersCollection,
  serverStateCollection,
} from "./client.ts";
import type {
  AssetChangeDoc,
  AssetChangeKind,
  AssetChangeWithId,
} from "./schema.ts";
import { child as childLogger } from "../log.ts";
import { getChangeBus } from "../runtime/change-bus.ts";

const log = childLogger("changes-repo");

const CURSOR_DOC_ID = "asset_changes_cursor";

// Tiny per-process cache for folder.path lookups. Folders are
// effectively immutable at the path level (rename is not a supported
// operation in the current schema) so we never invalidate; a process
// restart picks up any rare change. Keeps `recordAndPublishAssetChange`
// at a single Mongo round-trip per emit after the first hit.
const folderPathCache: Map<string, string> = new Map();

async function lookupFolderPath(
  dbOverride: Db | undefined,
  folderId: ObjectId,
): Promise<string | null> {
  const key = folderId.toHexString();
  const hit = folderPathCache.get(key);
  if (hit !== undefined) return hit;
  const coll = dbOverride
    ? dbOverride.collection("folders")
    : await foldersCollection();
  const doc = await coll.findOne(
    { _id: folderId },
    { projection: { path: 1 } },
  );
  const p = (doc as unknown as { path?: string } | null)?.path;
  if (typeof p !== "string") return null;
  folderPathCache.set(key, p);
  return p;
}

/** Test hook — drops the in-process folder.path cache. */
export function __resetFolderPathCacheForTests(): void {
  folderPathCache.clear();
}

/**
 * Compute the asset path relative to its folder root. Returns:
 *   - `""` if absPath is the folder root itself
 *   - `"sub/dir/file.dng"` for nested assets
 *   - `null` if absPath doesn't fall under the folder root (defensive —
 *     callers log a warn and persist null rather than a wrong path).
 *
 * Path separator is forward-slash throughout (the server stores POSIX
 * paths; the apple FP extension consumes them the same way).
 */
export function computeRelativePath(
  folderPath: string,
  absPath: string,
): string | null {
  // Normalise the folder path so a trailing slash on the folder doc
  // doesn't break the prefix-match.
  const rootNoTrail = folderPath.endsWith("/")
    ? folderPath.slice(0, -1)
    : folderPath;
  if (absPath === rootNoTrail) return "";
  const prefix = rootNoTrail + "/";
  if (!absPath.startsWith(prefix)) return null;
  return absPath.slice(prefix.length);
}

export async function allocateCursor(dbOverride?: Db): Promise<number> {
  const coll = dbOverride
    ? dbOverride.collection("server_state")
    : await serverStateCollection();
  const res = await coll.findOneAndUpdate(
    { _id: CURSOR_DOC_ID },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  // findOneAndUpdate returns the updated doc; `seq` is always present after
  // the first $inc (Mongo creates it set to the increment value on upsert).
  const seq = (res as unknown as { seq?: number } | null)?.seq;
  if (typeof seq !== "number") {
    throw new Error("allocateCursor: server_state doc missing seq after $inc");
  }
  return seq;
}

export interface RecordChangeInput {
  kind: AssetChangeKind;
  asset_id: ObjectId | null;
  folder_id: ObjectId | null;
  abs_path: string | null;
  /**
   * Path relative to the folder root. Optional at this layer — the
   * higher-level `recordAndPublishAssetChange` computes it from
   * `folder.path` + `abs_path`. Callers that drive the repo directly
   * (tests, the change-feed tailer) may pass it or leave it undefined.
   * Stored as `null` when not provided so old rows look the same as
   * absent-on-write rows.
   */
  relative_path?: string | null;
}

/**
 * Allocate a cursor, write the change row, return the cursor. Best-effort:
 * if the insert throws, the cursor allocation is wasted (gap in the
 * sequence). Callers should NOT block their primary write on this — the
 * recommended pattern is to call this AFTER a successful asset mutation
 * and let exceptions bubble only for logging.
 *
 * Invariant — cursors are monotonic but NOT contiguous. The allocate
 * step ($inc on server_state) and the insert step are two separate
 * Mongo ops; if the insert fails after the allocate succeeds we leak a
 * cursor and leave a gap in `asset_changes`. Consumers must tolerate
 * gaps:
 *   - The HTTP poll path filters `cursor > since` and returns whatever
 *     is present.
 *   - The SSE replay path filters `cursor > since` against the in-proc
 *     ring buffer (which only sees successful publishes, so gaps are
 *     invisible there but reappear after restart).
 *   - The Apple `ChangeFeedClient` saves the highest id it has seen
 *     from the SSE `id:` field and reconnects with that as `since`;
 *     it does not require `id == since + 1`.
 *   - `ChangeBus.isCursorReplayable(since)` checks `since + 1 >= floor`,
 *     which is correct under gaps (if floor > since + 1 the client
 *     can't be brought up to date by replay regardless of why the
 *     intermediate cursors are missing).
 * Do NOT introduce a Mongo transaction here — the codebase intentionally
 * avoids transactions, and the tolerate-gaps model is sufficient.
 */
export async function recordAssetChange(
  dbOverride: Db | undefined,
  input: RecordChangeInput
): Promise<number> {
  const cursor = await allocateCursor(dbOverride);
  const coll = dbOverride
    ? dbOverride.collection("asset_changes")
    : await assetChangesCollection();
  const doc: AssetChangeDoc = {
    cursor,
    asset_id: input.asset_id,
    folder_id: input.folder_id,
    kind: input.kind,
    abs_path: input.abs_path,
    relative_path: input.relative_path ?? null,
    at: new Date(),
  };
  try {
    await coll.insertOne(doc);
  } catch (err) {
    log.error({ err, cursor }, "recordAssetChange: insert failed");
    throw err;
  }
  return cursor;
}

export interface ListChangesQuery {
  since: number;
  limit: number;
}

export async function listChangesSince(
  dbOverride: Db | undefined,
  q: ListChangesQuery
): Promise<AssetChangeWithId[]> {
  const coll = dbOverride
    ? dbOverride.collection<AssetChangeDoc>("asset_changes")
    : await assetChangesCollection();
  const cursor = coll
    .find({ cursor: { $gt: q.since } })
    .sort({ cursor: 1 })
    .limit(Math.min(Math.max(q.limit, 1), 1000));
  return (await cursor.toArray()) as AssetChangeWithId[];
}

/**
 * High-level helper: record the change in Mongo AND publish to the
 * in-process bus so connected SSE clients see it immediately.
 *
 * Best-effort: errors are logged but never thrown. Change-row failures
 * must never fail the primary asset write — the system tolerates lost
 * events via the 409 stale-cursor path which triggers full re-enumeration.
 *
 * Resolves `relative_path` from the named folder root via a small
 * in-process cache so File Provider clients can route per-folder
 * invalidation precisely (Phase 6 item 2). This is the one place we do
 * the folder.path lookup — pushing it here keeps the ~12 call sites
 * free of folder boilerplate. When the caller pre-computed the
 * relative path (tests, change-feed replay), we use that and skip the
 * lookup.
 *
 * `dbOverride` is for tests that want to target an isolated database.
 * Production callers omit it; the global `getDb()` resolution applies.
 */
export async function recordAndPublishAssetChange(
  input: RecordChangeInput,
  dbOverride?: Db,
): Promise<void> {
  try {
    let relativePath: string | null = input.relative_path ?? null;
    if (relativePath === null && input.folder_id && input.abs_path) {
      const folderPath = await lookupFolderPath(dbOverride, input.folder_id);
      if (folderPath) {
        relativePath = computeRelativePath(folderPath, input.abs_path);
        if (relativePath === null) {
          log.warn(
            {
              folder_id: input.folder_id.toHexString(),
              folder_path: folderPath,
              abs_path: input.abs_path,
            },
            "recordAndPublishAssetChange: abs_path is outside folder.path; storing null relative_path"
          );
        }
      }
    }
    const enriched: RecordChangeInput = {
      ...input,
      relative_path: relativePath,
    };
    // Allocate + insert in Mongo, then publish to the bus locally from
    // the cursor + input. We avoid an extra `findOne({cursor})` round
    // trip: the bus payload is reconstructable from what we already
    // have (the `_id` we synthesize is unused by SSE consumers — they
    // only see the serialised SSE form, which strips `_id`).
    const cursor = await recordAssetChange(dbOverride, enriched);
    const synthetic: AssetChangeWithId = {
      _id: new ObjectId(),
      cursor,
      asset_id: input.asset_id,
      folder_id: input.folder_id,
      kind: input.kind,
      abs_path: input.abs_path,
      relative_path: relativePath,
      at: new Date(),
    } as AssetChangeWithId;
    getChangeBus().publish(synthetic);
  } catch (err) {
    log.warn(
      { err, kind: input.kind, abs_path: input.abs_path },
      "recordAndPublishAssetChange failed (best-effort, ignoring)"
    );
  }
}

/** Returns the highest cursor currently in the collection, or 0 if empty. */
export async function highestCursor(dbOverride?: Db): Promise<number> {
  const coll = dbOverride
    ? dbOverride.collection<AssetChangeDoc>("asset_changes")
    : await assetChangesCollection();
  const top = await coll.find({}).sort({ cursor: -1 }).limit(1).next();
  return top?.cursor ?? 0;
}
