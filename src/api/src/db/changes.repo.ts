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
import { assetChangesCollection, serverStateCollection } from "./client.ts";
import type {
  AssetChangeDoc,
  AssetChangeKind,
  AssetChangeWithId,
} from "./schema.ts";
import { child as childLogger } from "../log.ts";
import { getChangeBus } from "../runtime/change-bus.ts";

const log = childLogger("changes-repo");

const CURSOR_DOC_ID = "asset_changes_cursor";

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
 */
export async function recordAndPublishAssetChange(
  input: RecordChangeInput
): Promise<void> {
  try {
    // Allocate + insert in Mongo, then publish to the bus locally from
    // the cursor + input. We avoid an extra `findOne({cursor})` round
    // trip: the bus payload is reconstructable from what we already
    // have (the `_id` we synthesize is unused by SSE consumers — they
    // only see the serialised SSE form, which strips `_id`).
    const cursor = await recordAssetChange(undefined, input);
    const synthetic: AssetChangeWithId = {
      _id: new ObjectId(),
      cursor,
      asset_id: input.asset_id,
      folder_id: input.folder_id,
      kind: input.kind,
      abs_path: input.abs_path,
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
