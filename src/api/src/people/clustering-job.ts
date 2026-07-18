/**
 * Online face clustering — operator-triggered (or scheduled) helper that
 * groups face embeddings into `PersonDoc`s.
 *
 * v1: ONLINE only — for each unassigned face, find the nearest centroid
 *     under cosine similarity. If the best score >= `similarityThreshold`,
 *     assign to that person; else create a new auto-named "Person N" and
 *     seed its centroid with the face embedding.
 *
 *     Idempotent: re-running with the same face data is a no-op (every
 *     face is already assigned).
 *
 * Out of scope (v2): HDBSCAN / batch reclustering — see follow-up ticket.
 *
 * Centroids are stored as the L2-normalised mean of assigned face
 * embeddings on `PersonDoc.centroid`. Cosine similarity then collapses to
 * a dot product.
 */

import { type Filter, ObjectId, type AnyBulkWriteOperation } from 'mongodb';
import { assetsCollection, peopleCollection } from '../db/client.ts';
import type { AssetDoc, AssetFaceDoc, Bbox, PersonDoc } from '../db/schema.ts';
import { markAssetIdsForMeiliReindexBestEffort } from './people-search-reindex.ts';
import { writeAuthoritativeFaceCounts } from './people-face-count.repo.ts';
import { child as childLogger } from '../log.ts';
import { DEFAULT_SIMILARITY_THRESHOLD, EMBEDDING_DIM } from './cluster-embeddings.ts';
import {
  loadCentroids,
  loadMergeDismissals,
  loadUnassignedFaces,
  maxAutoNameIndex,
} from './cluster-load.ts';
import { prepareClusteringPassOffThread } from './cluster-pool.ts';
import { sortedPairKey, type MergeSuggestion } from './people-merge-suggestions.ts';

const log = childLogger('people:clustering');

// Re-exports for back-compat with prior public surface — these constants
// and helpers used to live in this file. The pure-function clustering
// core (`clusterEmbeddings`, `ClusterSeed`, etc.) is exported from
// `./cluster-embeddings.ts` directly; callers prefer that path so the
// harness can import without dragging the Mongo deps in this module
// along for the ride.
export {
  DEFAULT_SIMILARITY_THRESHOLD,
  EMBEDDING_DIM,
  l2Normalise,
  dotProduct,
  updateCentroid,
  clusterEmbeddings,
} from './cluster-embeddings.ts';
export type {
  ClusterSeed,
  OnlineClusterOptions,
  OnlineClusterResult,
} from './cluster-embeddings.ts';
// `recomputeCentroids` moved to ./cluster-load.ts (it runs on the worker now)
// but stays part of this module's public surface — the route + tests import
// it from here.
export { recomputeCentroids } from './cluster-load.ts';

export interface RunOnlineClusteringOptions {
  /** Cosine threshold to merge a face into an existing cluster. Faces
   * scoring below this go into a new "Person N" auto-name. Default 0.5. */
  similarityThreshold?: number;
}

export interface RunOnlineClusteringResult {
  /** Faces newly assigned during this run (was null, now points at a
   * person). Includes faces assigned to brand-new clusters. */
  assigned: number;
  /** Number of new "Person N" rows created during this run. */
  newPeople: number;
  /** Number of faces examined (assigned + skipped). Useful for tests. */
  scanned: number;
}

interface FaceRef {
  asset_id: ObjectId;
  face_index: number;
  /** Carried so brand-new "Person N" rows can capture the seeding face's
   * bbox as the cover crop without a second DB round-trip per new person.
   * The embedding is NOT carried here — clustering happens off-thread and
   * the embeddings never cross back into this (main-thread) write path. */
  bbox: Bbox;
}

interface CentroidEntry {
  person_id: ObjectId;
  /** L2-normalised — cosine similarity is then a dot product. */
  centroid: Float32Array;
  /** Number of faces that contributed to the running mean. Updated in
   * memory as we assign faces during this run so the centroid stays
   * representative without a per-face DB round trip. */
  face_count: number;
}

// ---------------------------------------------------------------------------
// Public API — DB-backed wrapper around the pure clustering core in
// `./cluster-embeddings.ts`. The pure function does the embedding →
// assignment math; this layer adds the Mongo round-trips: load existing
// centroids, persist assignments to `asset.faces[*].person_id`, create
// `PersonDoc` rows for new clusters, and trigger the cover-asset
// backfill.
// ---------------------------------------------------------------------------

/**
 * Walk every face that's missing a `person_id` and assign it to the
 * closest existing person (under cosine similarity, threshold default 0.5)
 * or create a new "Person N" cluster if no match is close enough.
 *
 * Idempotent: re-running with the same data assigns zero faces.
 *
 * Implementation: delegates the centroid-search / assignment math to the
 * pure `clusterEmbeddings` function in `./cluster-embeddings.ts` so the
 * harness scores the same code path that production runs. This layer
 * only handles the Mongo-shaped concerns: seed loading, persisting
 * `PersonDoc` rows for new clusters, buffering per-asset writes, and
 * the cover-asset backfill.
 */
export async function runOnlineClustering(
  options: RunOnlineClusteringOptions = {},
): Promise<RunOnlineClusteringResult> {
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  // Run the WHOLE load + compute stage off the main thread: the worker
  // recomputes centroids, loads + normalises every centroid and unassigned
  // face embedding, and runs the synchronous O(N·K·D) clustering pass — all
  // against its own Mongo handle. Output is identical to running the stage
  // in-process (same core, same data, same order); only a small serializable
  // result crosses back (assignments + updated centroids + per-face
  // envelopes). The embeddings themselves never reach this thread, so there
  // is no main-thread O(N·D) decode/normalize/marshal pass. See
  // `cluster-pool.ts` / `cluster-load.ts`.
  const { pass } = await prepareClusteringPassOffThread(threshold);
  const seedCount = pass.seedCount;

  // Reconstruct the live centroid entries (with ObjectIds) from the
  // serializable result. Seeds 0..seedCount-1 map 1:1 onto the loaded
  // person ids; new clusters (k ≥ seedCount) get a person id once they're
  // materialised below.
  const centroids: CentroidEntry[] = [];
  for (let k = 0; k < seedCount; k += 1) {
    centroids.push({
      person_id: new ObjectId(pass.seedPersonIds[k]),
      centroid: Float32Array.from(pass.clusters[k].centroid),
      face_count: pass.clusters[k].face_count,
    });
  }
  // Per-face envelopes (no embedding) carry the asset id + bbox the write
  // side needs.
  const faces: FaceRef[] = pass.faces.map((f) => ({
    asset_id: new ObjectId(f.asset_id_hex),
    face_index: f.face_index,
    bbox: f.bbox,
  }));
  let nextAutoIndex = pass.maxAutoIndex;

  let assigned = 0;
  let newPeople = 0;
  // Buffer assignments per (asset_id, face_index) so we can apply them
  // in a single bulk write per asset.
  const perAsset = new Map<
    string,
    { assetId: ObjectId; updates: Array<{ index: number; personId: string }> }
  >();
  // Track which new-cluster index has been materialised to a `PersonDoc`
  // — multiple faces can land in the same new cluster, but we only
  // create the row once (and the first face seeds the cover bbox).
  const newPersonIds = new Map<number, ObjectId>();

  const newPeopleDocs: Array<PersonDoc & { _id: ObjectId }> = [];
  const now = new Date().toISOString();

  for (let i = 0; i < faces.length; i += 1) {
    const face = faces[i];
    const clusterIdx = pass.assignments[i];
    let personId: ObjectId;
    if (clusterIdx < seedCount) {
      // Matched an existing person — reuse its ObjectId.
      personId = centroids[clusterIdx].person_id;
    } else {
      // Brand-new cluster. Materialise a `PersonDoc` on first contact;
      // subsequent faces in the same new cluster reuse that ObjectId.
      const cached = newPersonIds.get(clusterIdx);
      if (cached) {
        personId = cached;
      } else {
        personId = new ObjectId();
        newPersonIds.set(clusterIdx, personId);

        nextAutoIndex += 1;
        const name = `Person ${nextAutoIndex}`;
        const seedCentroid = Float32Array.from(pass.clusters[clusterIdx].centroid);

        newPeopleDocs.push({
          _id: personId,
          name,
          created_at: now,
          updated_at: now,
          merged_into: null,
          centroid: Array.from(seedCentroid),
          centroid_face_count: pass.clusters[clusterIdx].face_count,
          cover_asset_id: face.asset_id.toHexString(),
          cover_bbox: face.bbox,
        });
        newPeople += 1;
      }
    }
    bufferAssignment(perAsset, face, personId.toHexString());
    assigned += 1;
  }

  // Batch insert new people.
  if (newPeopleDocs.length > 0) {
    const peopleC = await peopleCollection();
    // `WithId<PersonDoc>` allows a caller-supplied `_id`; cast via `unknown`
    // because the Mongo driver's `insertMany` signature expects `OptionalUnlessRequiredId<PersonDoc>`,
    // which is the same shape but not directly assignable from our intersection type.
    await peopleC.insertMany(newPeopleDocs as unknown as PersonDoc[]);
  }

  // Apply buffered assignments per asset doc via bulkWrite.
  const assets = await assetsCollection();
  const assetOps: AnyBulkWriteOperation<AssetDoc>[] = [];
  for (const entry of perAsset.values()) {
    const set: Record<string, string> = {};
    for (const u of entry.updates) {
      set[`faces.${u.index}.person_id`] = u.personId;
    }
    assetOps.push({
      updateOne: {
        filter: { _id: entry.assetId },
        update: { $set: set },
      },
    });
  }
  if (assetOps.length > 0) {
    await assets.bulkWrite(assetOps);
  }

  // Persist refreshed centroids so subsequent runs converge. Only update
  // clusters that actually received new faces during this pass.
  const changedClusterIndices = new Set<number>(pass.assignments);
  const centroidsToPersist: CentroidEntry[] = [];
  for (const k of changedClusterIndices) {
    // New clusters (k >= seedCount) were already written with their final
    // centroid/count in newPeopleDocs above, so they skip a second write.
    if (k >= seedCount) continue;

    const personId = centroids[k].person_id;
    centroidsToPersist.push({
      person_id: personId,
      centroid: Float32Array.from(pass.clusters[k].centroid),
      face_count: pass.clusters[k].face_count,
    });
  }
  await persistCentroids(centroidsToPersist);

  // Persist this run's merge suggestions (§ person-page merge suggestions).
  await persistMergeSuggestions(pass.seedPersonIds, pass.mergeSuggestions);

  // Backfill cover thumbs for any live person without one. Covers may be
  // missing on rows created before cover-seeding landed, or on people
  // created manually via `POST /api/people` ahead of any face assignment.
  await backfillCoverAssets();

  // Intentional background-pass recompute: the clustering pass is the one
  // place that walks all face assignments, so it doubles as the authoritative
  // self-heal for any incremental drift from manual assign/unassign/hide/merge
  // between passes. `faceCountByPerson` is an extra O(total-faces) aggregation,
  // but it runs once per clustering pass (never per request) and clustering
  // already does a full-ish pass, so the cost is acceptable — and it's what
  // guarantees `face_count` self-heals (up AND down) regardless of incremental
  // bugs. Deliberate; do not remove.
  const { faceCountByPerson } = await import('./people-face-count.repo.ts');
  const authCounts = await faceCountByPerson();
  await writeAuthoritativeFaceCounts(authCounts);

  // Re-index exactly the assets whose face assignments changed so person-name
  // search reflects the new clustering — not every asset of the touched
  // people, which on a large library would re-queue huge numbers of unchanged
  // assets. Fire-and-forget; a search-index hiccup must not fail the run.
  const changedAssetIds = [...perAsset.values()].map((e) => e.assetId);
  if (changedAssetIds.length > 0) {
    markAssetIdsForMeiliReindexBestEffort(changedAssetIds);
  }

  log.info({ assigned, newPeople, scanned: faces.length, threshold }, 'online clustering finished');
  return { assigned, newPeople, scanned: faces.length };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
//
// The Mongo LOAD + COMPUTE stage (`recomputeCentroids`, `loadCentroids`,
// `loadUnassignedFaces`, `maxAutoNameIndex`, `clusterEmbeddings`) moved to
// `./cluster-load.ts` so it can run on the cluster Worker off the main
// thread — see #710. This file keeps only the cheap, write-side Mongo
// concerns below.

/**
 * Set `cover_asset_id` on every live person that is missing one (no field,
 * `null`, or only the legacy `cover_face_id`) by picking each person's
 * highest-confidence assigned face. Idempotent.
 *
 * Single aggregation against `assets` groups by `person_id` and reports
 * the asset id whose face has the highest detector confidence; results
 * are applied via one bulkWrite. This replaces an earlier per-person
 * `findOne` + `updateOne` loop that ran in O(N) round-trips.
 *
 * Also `$unset`s the legacy `cover_face_id` field on the same write so
 * docs migrate forward without a separate migration step.
 *
 * Exposed via `backfillCoverAssets()` so the `/api/people` list handler
 * can opportunistically heal existing installs that were clustered before
 * this code shipped — the fast path is one `find` that returns 0 rows.
 *
 * Singleflight coalesces concurrent callers onto a single in-flight run so
 * a burst of /api/people requests on a cold/legacy DB doesn't fan out into
 * N duplicate aggregations + bulkWrites against the same docs.
 */
let backfillInFlight: Promise<void> | null = null;

export function backfillCoverAssets(): Promise<void> {
  if (backfillInFlight) return backfillInFlight;
  backfillInFlight = doBackfillCoverAssets().finally(() => {
    backfillInFlight = null;
  });
  return backfillInFlight;
}

async function doBackfillCoverAssets(): Promise<void> {
  const peopleC = await peopleCollection();
  const assets = await assetsCollection();

  const missing = await peopleC
    .find(
      {
        merged_into: null,
        // Rows that never picked a cover, OR rows that have an asset id
        // but no bbox yet (existed before cover-crop landed) — both heal
        // on the same pass.
        $or: [
          { cover_asset_id: { $exists: false } },
          { cover_asset_id: null },
          { cover_bbox: { $exists: false } },
        ],
      } as Filter<PersonDoc>,
      { projection: { _id: 1 } },
    )
    .toArray();
  if (missing.length === 0) return;

  const missingHexIds = missing.map((p) => p._id.toHexString());

  // One aggregation produces `(person_hex → best_asset_id, best_bbox)` for
  // every person in `missingHexIds`. $sort + $group/$first picks the
  // highest-confidence face per person; ties break by Mongo's insertion
  // order on the unwound rows, which is deterministic enough for "any
  // reasonable face." Hidden faces are filtered out so they can't become
  // a person's cover.
  const cursor = assets.aggregate<{
    _id: string;
    best_asset_id: ObjectId;
    best_bbox: AssetFaceDoc['bbox'];
  }>([
    { $match: { faces: { $exists: true, $ne: [] } } },
    { $unwind: '$faces' },
    { $match: { 'faces.person_id': { $in: missingHexIds } } },
    { $match: { 'faces.hidden': { $ne: true } } },
    {
      $project: {
        _id: 1,
        person_id: '$faces.person_id',
        confidence: '$faces.confidence',
        bbox: '$faces.bbox',
      },
    },
    { $sort: { confidence: -1 } },
    {
      $group: {
        _id: '$person_id',
        best_asset_id: { $first: '$_id' },
        best_bbox: { $first: '$bbox' },
      },
    },
  ]);

  const updates: Array<{
    updateOne: {
      filter: Filter<PersonDoc>;
      update: {
        $set: {
          cover_asset_id: string;
          cover_bbox: AssetFaceDoc['bbox'];
          updated_at: string;
        };
        $unset: { cover_face_id: '' };
      };
    };
  }> = [];
  const now = new Date().toISOString();
  for await (const row of cursor) {
    let personId: ObjectId;
    try {
      personId = new ObjectId(row._id);
    } catch {
      continue;
    }
    updates.push({
      updateOne: {
        filter: { _id: personId } as Filter<PersonDoc>,
        update: {
          $set: {
            cover_asset_id: row.best_asset_id.toHexString(),
            cover_bbox: row.best_bbox,
            updated_at: now,
          },
          // Drop the legacy field so old + new docs converge on one shape.
          $unset: { cover_face_id: '' },
        },
      },
    });
  }
  if (updates.length > 0) {
    await peopleC.bulkWrite(updates);
  }
}

async function persistCentroids(centroids: CentroidEntry[]): Promise<void> {
  if (centroids.length === 0) return;
  const peopleC = await peopleCollection();
  const ops: AnyBulkWriteOperation<PersonDoc>[] = centroids.map((c) => ({
    updateOne: {
      filter: { _id: c.person_id },
      update: {
        $set: {
          centroid: Array.from(c.centroid),
          centroid_face_count: c.face_count,
        },
      },
    },
  }));
  await peopleC.bulkWrite(ops);
}

/**
 * Bulk-write this run's merge-suggestion results across EVERY live person
 * the load stage considered (`seedPersonIds`), not just the ones with a
 * qualifying match — anyone absent from `suggestions` gets explicitly
 * cleared to `null` so a stale suggestion (dismissed, or the match since
 * hidden/merged/no-longer-best) self-heals on the very next run.
 */
async function persistMergeSuggestions(
  seedPersonIds: string[],
  suggestions: MergeSuggestion[],
): Promise<void> {
  if (seedPersonIds.length === 0) return;
  // Re-load dismissals rather than reusing the prepare-time snapshot: a
  // "not the same person" dismiss that landed while this run was in flight
  // would otherwise be overwritten here, resurrecting the suggestion until
  // the next run (which only comes when new faces arrive). Dropped entries
  // fall through to the clear-to-null path below.
  const dismissed = await loadMergeDismissals();
  const live = suggestions.filter(
    (s) => !dismissed.has(sortedPairKey(s.personIdHex, s.suggestedPersonIdHex)),
  );
  const byPerson = new Map(live.map((s) => [s.personIdHex, s]));
  const peopleC = await peopleCollection();
  const ops: AnyBulkWriteOperation<PersonDoc>[] = seedPersonIds.map((idHex) => {
    const s = byPerson.get(idHex);
    return {
      updateOne: {
        filter: { _id: new ObjectId(idHex) },
        update: {
          $set: {
            suggested_merge_person_id: s ? new ObjectId(s.suggestedPersonIdHex) : null,
            suggested_merge_score: s ? s.score : null,
          },
        },
      },
    };
  });
  await peopleC.bulkWrite(ops);
}

function bufferAssignment(
  buffer: Map<string, { assetId: ObjectId; updates: Array<{ index: number; personId: string }> }>,
  face: FaceRef,
  personHex: string,
): void {
  const key = face.asset_id.toHexString();
  let entry = buffer.get(key);
  if (!entry) {
    entry = { assetId: face.asset_id, updates: [] };
    buffer.set(key, entry);
  }
  entry.updates.push({ index: face.face_index, personId: personHex });
}

// Vector helpers (l2Normalise / dotProduct / updateCentroid) live in
// `./cluster-embeddings.ts` and are re-exported at the top of this file
// for callers that import them through here.

/** Re-export kept for the test suite. */
export const _internals = {
  loadCentroids,
  loadUnassignedFaces,
  maxAutoNameIndex,
  persistMergeSuggestions,
  EMBEDDING_DIM,
  DEFAULT_SIMILARITY_THRESHOLD,
};

// Suppress lint warnings for the unused `AssetDoc` / `AssetFaceDoc` imports
// — they're load-bearing for type narrowing in test files that import this
// module, so we keep them in scope. A single cast in a comment ensures the
// imports survive tree shaking from a `tsc --noEmit` perspective.
type _AssetDocAlive = AssetDoc;
type _AssetFaceDocAlive = AssetFaceDoc;
type _Aliases = _AssetDocAlive | _AssetFaceDocAlive;
