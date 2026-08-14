/**
 * merge-duplicate-assets-2026-05-21
 *
 * Healing pass: collapse pre-existing rows that share a `maple_id` into a
 * single row with a union of every group member's `fileinfo[]`.
 *
 * Why this exists even though the unique partial index `maple_id_gt_1`
 * forbids the state: on deploys where the index was never built (or was
 * dropped at some point) and PR 1's hash-stage races didn't merge cleanly,
 * the collection can carry "physical" duplicates that the runtime
 * constraint would now reject on insert. `ensureIndexes` calls this
 * BEFORE the `maple_id_gt_1` createIndex so the index creation succeeds
 * on the cleaned-up state — without this ordering, `createIndex` would
 * throw `DuplicateKey` and the boot would abort.
 *
 * Survivor rule: earliest `indexed_at` wins. This is the row most likely to
 * carry user-edited fields (rating, flag, color_label, faces, sidecar
 * mirrors). Ties on `indexed_at` are broken by `_id.toString()` so the
 * outcome is deterministic across boots.
 *
 * User-edited fields are NOT merged across rows — only the survivor's are
 * kept. Operators are expected to redo any edits made on losers; we log
 * the survivor + loser ids so audit is possible.
 *
 * Idempotent: a second call finds zero groups and is a no-op. Sentinel-gated
 * in `ensureIndexes` so it only runs once per database.
 *
 * Two-phase batching (vs. one `find` + `updateOne` + `deleteMany` per group):
 * every group's candidate `_id`s are resolved in a single batched `find`,
 * re-partitioned in memory back into their groups (via a `_id → maple_id`
 * map built from the aggregate's own `ids` arrays — no second query needed),
 * and every group's survivor `updateOne` + loser `deleteMany` are carried in
 * one `bulkWrite({ ordered: false })`. Survivor selection and the `fileinfo`
 * union are computed exactly as before; only the round-trips are batched.
 * This is a destructive migration (irreversible `deleteMany`), so the pinned
 * semantics are covered by `migrations.merge-duplicates.test.ts` — run
 * against the pre-refactor per-group implementation first, then re-run
 * unchanged against this batched version.
 */

import type { AnyBulkWriteOperation, Db, ObjectId } from 'mongodb';
import { child as childLogger } from '../log.ts';

const log = childLogger('db:migrations');

export interface MergeDuplicatesResult {
  scanned_groups: number;
  merged_groups: number;
  deleted_rows: number;
}

interface DupGroup {
  _id: string;
  ids: ObjectId[];
  count: number;
}

interface FileInfoEntryShape {
  path: string;
  filename: string;
  library_id: ObjectId;
  deleted_at?: string | null;
}

interface DupRow {
  _id: ObjectId;
  indexed_at?: string;
  fileinfo?: FileInfoEntryShape[];
  rating?: number;
  flag?: number;
  color_label?: string;
}

/** Earliest `indexed_at` survives; ties broken by `_id` for determinism. */
function sortByIndexedAt(rows: DupRow[]): DupRow[] {
  return [...rows].sort((a, b) => {
    const ai = a.indexed_at ?? '';
    const bi = b.indexed_at ?? '';
    if (ai === bi) return a._id.toString().localeCompare(b._id.toString());
    return ai.localeCompare(bi);
  });
}

/**
 * Union `fileinfo[]` across a group's rows, de-duped by (library_id, path,
 * filename). The key is JSON-encoded so `|` (or any other separator)
 * appearing inside `path` / `filename` can't cause collisions.
 *
 * When two entries share the key but one is live (`deleted_at` absent/null)
 * and the other is tombstoned, prefer the live entry — otherwise the
 * first-wins ordering could preserve a deleted entry for a path that's
 * actually still on disk on another row.
 */
function unionFileinfo(rows: DupRow[]): FileInfoEntryShape[] {
  const seen = new Map<string, FileInfoEntryShape>();
  for (const row of rows) {
    for (const entry of row.fileinfo ?? []) {
      const key = JSON.stringify([entry.library_id.toHexString(), entry.path, entry.filename]);
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, entry);
        continue;
      }
      const existingDead = existing.deleted_at != null;
      const candidateDead = entry.deleted_at != null;
      if (existingDead && !candidateDead) {
        seen.set(key, entry);
      }
      // Otherwise (both live, both dead, or candidate dead while existing
      // live) keep the existing entry — first-seen wins.
    }
  }
  return Array.from(seen.values());
}

/**
 * Every candidate `_id` mapped back to the group (`maple_id`) it came from,
 * plus the flattened id list for one batched `find` in place of one `find()`
 * per group. Built entirely from the aggregate's own `ids` arrays, so this
 * needs no extra query.
 */
function indexGroupIds(dupes: DupGroup[]): {
  idToGroupKey: Map<string, string>;
  allIds: ObjectId[];
} {
  const idToGroupKey = new Map<string, string>();
  const allIds: ObjectId[] = [];
  for (const group of dupes) {
    for (const id of group.ids) {
      idToGroupKey.set(id.toString(), group._id);
      allIds.push(id);
    }
  }
  return { idToGroupKey, allIds };
}

/** Re-partitions the single batched `find` result back into per-group rows. */
function partitionRowsByGroup(
  rows: DupRow[],
  idToGroupKey: Map<string, string>,
): Map<string, DupRow[]> {
  const rowsByGroup = new Map<string, DupRow[]>();
  for (const row of rows) {
    const key = idToGroupKey.get(row._id.toString());
    if (key === undefined) continue; // every row came from allIds — defensive only
    const list = rowsByGroup.get(key);
    if (list) list.push(row);
    else rowsByGroup.set(key, [row]);
  }
  return rowsByGroup;
}

interface GroupMergeLogEntry {
  maple_id: string;
  survivor: string;
  losers: string[];
  merged_locations: number;
}

/**
 * Computes one group's survivor `updateOne` + loser `deleteMany` ops (to be
 * carried in the caller's single `bulkWrite`) plus its audit log entry. Null
 * when the group no longer has 2+ rows at merge time (e.g. a prior partial
 * run already collapsed it).
 */
function buildGroupMergeOps(
  group: DupGroup,
  rowsByGroup: Map<string, DupRow[]>,
): { ops: AnyBulkWriteOperation[]; logEntry: GroupMergeLogEntry } | null {
  const groupRows = rowsByGroup.get(group._id) ?? [];
  if (groupRows.length < 2) return null;

  const sorted = sortByIndexedAt(groupRows);
  const survivor = sorted[0]!;
  const losers = sorted.slice(1);
  const merged = unionFileinfo(sorted);

  return {
    ops: [
      { updateOne: { filter: { _id: survivor._id }, update: { $set: { fileinfo: merged } } } },
      { deleteMany: { filter: { _id: { $in: losers.map((l) => l._id) } } } },
    ],
    logEntry: {
      maple_id: group._id,
      survivor: survivor._id.toHexString(),
      losers: losers.map((l) => l._id.toHexString()),
      merged_locations: merged.length,
    },
  };
}

export async function mergeDuplicateAssets(db: Db): Promise<MergeDuplicatesResult> {
  const dupes = await db
    .collection('assets')
    .aggregate<DupGroup>([
      { $match: { maple_id: { $type: 'string' } } },
      { $group: { _id: '$maple_id', ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  if (dupes.length === 0) {
    return { scanned_groups: 0, merged_groups: 0, deleted_rows: 0 };
  }

  const { idToGroupKey, allIds } = indexGroupIds(dupes);

  // Projection: we only need the fields used by the survivor pick and the
  // fileinfo union. Pulling whole docs would drag along `vision`,
  // `search_blob`, etc. for every loser we're about to delete.
  const rows = (await db
    .collection('assets')
    .find(
      { _id: { $in: allIds } },
      {
        projection: {
          _id: 1,
          indexed_at: 1,
          fileinfo: 1,
          rating: 1,
          flag: 1,
          color_label: 1,
        },
      },
    )
    .toArray()) as DupRow[];

  const rowsByGroup = partitionRowsByGroup(rows, idToGroupKey);

  const ops: AnyBulkWriteOperation[] = [];
  const logEntries: GroupMergeLogEntry[] = [];
  let merged_groups = 0;

  for (const group of dupes) {
    const built = buildGroupMergeOps(group, rowsByGroup);
    if (!built) continue;
    ops.push(...built.ops);
    logEntries.push(built.logEntry);
    merged_groups += 1;
  }

  const deleted_rows =
    ops.length > 0
      ? ((await db.collection('assets').bulkWrite(ops, { ordered: false })).deletedCount ?? 0)
      : 0;

  for (const entry of logEntries) {
    log.info(entry, 'merge-duplicate-assets: collapsed group');
  }

  return {
    scanned_groups: dupes.length,
    merged_groups,
    deleted_rows,
  };
}
