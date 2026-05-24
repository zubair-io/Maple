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

import { type Filter, ObjectId } from 'mongodb';
import { assetsCollection, peopleCollection } from '../db/client.ts';
import type { AssetDoc, AssetFaceDoc, Bbox, PersonDoc } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  EMBEDDING_DIM,
  l2Normalise,
  clusterEmbeddings,
  type ClusterSeed,
} from './cluster-embeddings.ts';

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
  embedding: Float32Array;
  /** Carried alongside the embedding so brand-new "Person N" rows can
   * capture the seeding face's bbox as the cover crop without a second
   * DB round-trip per new person. */
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
  // Refresh centroids from the current assignment state. Cheap and means
  // we never trust a stale cached centroid (e.g. after a merge).
  await recomputeCentroids();

  const centroids = await loadCentroids();
  let nextAutoIndex = await maxAutoNameIndex();
  const faces = await loadUnassignedFaces();

  // Hand the embedding batch to the pure clustering core. The seeds
  // array carries our existing centroids in stable order so the
  // assignment indices we get back map 1:1 back onto `centroids[i]`.
  const seeds: ClusterSeed[] = centroids.map((c) => ({
    centroid: c.centroid,
    face_count: c.face_count,
  }));
  const seedCount = seeds.length;
  const result = clusterEmbeddings(
    faces.map((f) => f.embedding),
    { similarityThreshold: threshold, seeds },
  );

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

  for (let i = 0; i < faces.length; i += 1) {
    const face = faces[i];
    const clusterIdx = result.assignments[i];
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
        nextAutoIndex += 1;
        const name = `Person ${nextAutoIndex}`;
        personId = await createAutoPerson(name, face.embedding, face.asset_id, face.bbox);
        newPersonIds.set(clusterIdx, personId);
        newPeople += 1;
      }
    }
    bufferAssignment(perAsset, face, personId.toHexString());
    assigned += 1;
  }

  // Apply buffered assignments per asset doc. One updateOne per asset is
  // simpler than bulkWrite + arrayFilters on the rare hot-spot asset; the
  // total face count is small.
  const assets = await assetsCollection();
  for (const entry of perAsset.values()) {
    const set: Record<string, string> = {};
    for (const u of entry.updates) {
      set[`faces.${u.index}.person_id`] = u.personId;
    }
    await assets.updateOne({ _id: entry.assetId }, { $set: set });
  }

  // Persist refreshed centroids so subsequent runs converge. The pure
  // core returned updated seeds (positions 0..seedCount-1) followed by
  // any newly-created clusters — fold those back into the live entries
  // before writing.
  for (let k = 0; k < seedCount; k += 1) {
    centroids[k].centroid = result.clusters[k].centroid;
    centroids[k].face_count = result.clusters[k].face_count;
  }
  for (let k = seedCount; k < result.clusters.length; k += 1) {
    const personId = newPersonIds.get(k);
    if (!personId) continue;
    centroids.push({
      person_id: personId,
      centroid: result.clusters[k].centroid,
      face_count: result.clusters[k].face_count,
    });
  }
  await persistCentroids(centroids);

  // Backfill cover thumbs for any live person without one. Covers may be
  // missing on rows created before cover-seeding landed, or on people
  // created manually via `POST /api/people` ahead of any face assignment.
  await backfillCoverAssets();

  log.info({ assigned, newPeople, scanned: faces.length, threshold }, 'online clustering finished');
  return { assigned, newPeople, scanned: faces.length };
}

/**
 * Recompute every person's centroid from current `asset.faces` assignments.
 * Pure helper — no decision-making; just refreshes the stored mean.
 *
 * Skips people whose stored `centroid_face_count` matches the live count
 * (i.e. nothing changed since the last recompute), which keeps repeat runs
 * cheap.
 */
export async function recomputeCentroids(): Promise<number> {
  const peopleC = await peopleCollection();
  const assets = await assetsCollection();
  const livePeople = await peopleC.find({ merged_into: null } as Filter<PersonDoc>).toArray();
  let updated = 0;
  for (const person of livePeople) {
    const personHex = person._id.toHexString();
    // Pull the embedding off every face assigned to this person. Two
    // $match stages around $unwind narrow each side: the first lets the
    // planner skip docs that don't have any matching face, and the
    // second drops the unwound rows whose `person_id` is for someone
    // else.
    const cursor = assets.aggregate<{ embedding: number[] }>([
      { $match: { 'faces.person_id': personHex } },
      { $unwind: '$faces' },
      { $match: { 'faces.person_id': personHex } },
      // Hidden faces are out of clustering — they should not contribute
      // to the centroid even if they somehow still carry a `person_id`.
      { $match: { 'faces.hidden': { $ne: true } } },
      { $match: { 'faces.embedding': { $exists: true, $ne: [] } } },
      { $project: { embedding: '$faces.embedding' } },
    ]);
    let count = 0;
    let mean: Float32Array | null = null;
    for await (const row of cursor) {
      if (!Array.isArray(row.embedding) || row.embedding.length !== EMBEDDING_DIM) continue;
      const e = Float32Array.from(row.embedding);
      if (mean === null) {
        mean = new Float32Array(EMBEDDING_DIM);
        for (let i = 0; i < EMBEDDING_DIM; i += 1) mean[i] = e[i];
      } else {
        for (let i = 0; i < EMBEDDING_DIM; i += 1) mean[i] += e[i];
      }
      count += 1;
    }
    if (count === 0 || mean === null) {
      // Nobody assigned — clear the centroid so it doesn't bias future runs.
      await peopleC.updateOne(
        { _id: person._id },
        { $set: { centroid: [], centroid_face_count: 0 } },
      );
      continue;
    }
    for (let i = 0; i < EMBEDDING_DIM; i += 1) mean[i] /= count;
    const normalised = l2Normalise(mean);
    if (
      (person.centroid_face_count ?? -1) === count &&
      person.centroid &&
      person.centroid.length === EMBEDDING_DIM
    ) {
      // Centroid unchanged — skip the write.
      continue;
    }
    await peopleC.updateOne(
      { _id: person._id },
      {
        $set: {
          centroid: Array.from(normalised),
          centroid_face_count: count,
        },
      },
    );
    updated += 1;
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function loadCentroids(): Promise<CentroidEntry[]> {
  const peopleC = await peopleCollection();
  const rows = await peopleC.find({ merged_into: null } as Filter<PersonDoc>).toArray();
  const out: CentroidEntry[] = [];
  for (const r of rows) {
    if (!r.centroid || r.centroid.length !== EMBEDDING_DIM) continue;
    out.push({
      person_id: r._id,
      centroid: l2Normalise(Float32Array.from(r.centroid)),
      face_count: r.centroid_face_count ?? 0,
    });
  }
  return out;
}

async function loadUnassignedFaces(): Promise<FaceRef[]> {
  const assets = await assetsCollection();
  const cursor = assets.aggregate<{
    _id: ObjectId;
    face_index: number;
    embedding: number[];
    bbox: Bbox;
  }>([
    { $match: { faces: { $exists: true, $ne: [] } } },
    { $unwind: { path: '$faces', includeArrayIndex: 'face_index' } },
    { $match: { 'faces.person_id': null } },
    // Operator-hidden faces stay out of clustering — re-running shouldn't
    // re-assign them to anyone.
    { $match: { 'faces.hidden': { $ne: true } } },
    { $match: { 'faces.embedding': { $exists: true, $ne: [] } } },
    {
      $project: {
        face_index: 1,
        embedding: '$faces.embedding',
        bbox: '$faces.bbox',
      },
    },
  ]);
  const out: FaceRef[] = [];
  for await (const row of cursor) {
    if (!Array.isArray(row.embedding) || row.embedding.length !== EMBEDDING_DIM) continue;
    out.push({
      asset_id: row._id,
      face_index: row.face_index,
      embedding: l2Normalise(Float32Array.from(row.embedding)),
      bbox: row.bbox,
    });
  }
  return out;
}

/** Highest "Person N" suffix currently in the DB so brand-new auto-names
 * extend the sequence rather than collide. Returns 0 when no auto-named
 * person exists. */
async function maxAutoNameIndex(): Promise<number> {
  const peopleC = await peopleCollection();
  const cursor = peopleC.find({ name: { $regex: /^Person \d+$/ } } as Filter<PersonDoc>);
  let maxIdx = 0;
  for await (const row of cursor) {
    const m = /^Person (\d+)$/.exec(row.name);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > maxIdx) maxIdx = n;
  }
  return maxIdx;
}

async function createAutoPerson(
  name: string,
  embedding: Float32Array,
  coverAssetId: ObjectId,
  coverBbox: Bbox,
): Promise<ObjectId> {
  const peopleC = await peopleCollection();
  const doc: PersonDoc = {
    name,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    merged_into: null,
    centroid: Array.from(l2Normalise(embedding)),
    centroid_face_count: 1,
    cover_asset_id: coverAssetId.toHexString(),
    cover_bbox: coverBbox,
  };
  const result = await peopleC.insertOne(doc as PersonDoc);
  return result.insertedId;
}

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
  const peopleC = await peopleCollection();
  for (const c of centroids) {
    await peopleC.updateOne(
      { _id: c.person_id },
      {
        $set: {
          centroid: Array.from(c.centroid),
          centroid_face_count: c.face_count,
        },
      },
    );
  }
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
