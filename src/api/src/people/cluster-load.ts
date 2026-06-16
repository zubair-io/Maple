/**
 * Mongo-backed clustering LOAD + COMPUTE stage. Owns every O(N·D) pass over
 * the embedding set: the per-row `Float32Array.from` + `l2Normalise` in
 * `loadCentroids` / `loadUnassignedFaces`, the per-centroid mean accumulation
 * + `l2Normalise` in `recomputeCentroids`, and the synchronous
 * `clusterEmbeddings` pass itself.
 *
 * These used to live inline in `clustering-job.ts` on the main thread. They
 * now live here so they can run on the cluster Worker (`cluster.worker.ts`),
 * which connects to Mongo with its own handle — eliminating all three
 * main-thread blockers from #710:
 *
 *   1. The `Float32Array[]` structured-clone across `postMessage` (the
 *      embeddings never leave the worker now — only assignments + centroids
 *      come back).
 *   2. The per-row decode + normalize between `getMore` round-trips.
 *   3. The `recomputeCentroids` mean + normalize over every assigned face.
 *
 * Output is byte-for-byte identical to the prior inline code: the SAME
 * functions run in the SAME order (recompute → load centroids → load
 * unassigned faces → cluster). Critically, `recomputeCentroids` still WRITES
 * the normalised centroid back to Mongo and `loadCentroids` re-reads + re-
 * normalises it — we deliberately do NOT fuse the two, because the double
 * normalize is part of the existing numeric path and fusing it would shift
 * the last ULPs and could flip an assignment near the 0.5 threshold.
 *
 * `clustering-job.ts` keeps every WRITE-side concern (person creation,
 * assignment buffering, centroid persistence, cover backfill, meili reindex)
 * on the main thread — those are cheap Mongo round-trips, not O(N·D) CPU.
 */

import { type Filter, ObjectId, type AnyBulkWriteOperation } from 'mongodb';
import { assetsCollection, peopleCollection } from '../db/client.ts';
import type { Bbox, PersonDoc } from '../db/schema.ts';
import {
  clusterEmbeddings,
  DEFAULT_SIMILARITY_THRESHOLD,
  EMBEDDING_DIM,
  l2Normalise,
  type ClusterSeed,
} from './cluster-embeddings.ts';

/** A loaded centroid, ready to seed the clustering pass. The `person_id` is
 * kept as a hex string so the whole structure is `postMessage`-serializable
 * when the load runs on the worker. */
export interface LoadedCentroid {
  person_id_hex: string;
  /** L2-normalised — cosine similarity is then a dot product. */
  centroid: Float32Array;
  /** Number of faces that contributed to the running mean. */
  face_count: number;
}

/** An unassigned face ref WITHOUT its embedding. The embedding stays inside
 * the load/cluster stage and never crosses the worker boundary — only this
 * envelope (asset id + face index + bbox) is needed by the write side. */
export interface FaceEnvelope {
  asset_id_hex: string;
  face_index: number;
  bbox: Bbox;
}

/** A cluster (centroid + member count) as plain JSON — `number[]` rather than
 * `Float32Array` so it serializes losslessly across `postMessage`. */
export interface SerializedCluster {
  centroid: number[];
  face_count: number;
}

/**
 * The complete result of the load + compute stage, fully serializable so it
 * can cross the worker→main boundary. No embeddings; only assignments,
 * updated centroids, and per-face envelopes.
 */
export interface PreparedClusteringPass {
  /** Number of pre-existing seeds (centroids loaded from the DB). Cluster
   * ids in `[0, seedCount)` reference these; ids ≥ `seedCount` are new. */
  seedCount: number;
  /** Hex person ids for the loaded seeds, in load order. `seedPersonIds[k]`
   * is the person for cluster `k` where `k < seedCount`. */
  seedPersonIds: string[];
  /** `assignments[i]` is the cluster id for face `i`. */
  assignments: number[];
  /** Updated clusters (seeds 0..seedCount-1, then any new clusters). */
  clusters: SerializedCluster[];
  /** Per-face envelope (no embedding), index-aligned with `assignments`. */
  faces: FaceEnvelope[];
  /** Highest existing "Person N" suffix so new auto-names extend the run. */
  maxAutoIndex: number;
  /** How many people had their centroid refreshed by the recompute step.
   * Carried for parity with the prior `recomputeCentroids()` return value
   * (the value the standalone `recomputeCentroids` export must still yield). */
  recomputed: number;
}

/**
 * Run the full load + compute stage against Mongo. This is the ONLY function
 * that touches the embedding set; it runs either on the cluster Worker (with
 * the worker's own Mongo handle) or in-process as the no-Worker fallback.
 *
 * Order is load-bearing for output parity — see the module header.
 */
export async function prepareClusteringPass(
  similarityThreshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): Promise<PreparedClusteringPass> {
  // 1. Refresh centroids from current assignment state (writes back to Mongo).
  const recomputed = await recomputeCentroids();

  // 2. Load the (re-normalised) centroids as clustering seeds.
  const centroids = await loadCentroids();

  // 3. Highest existing auto-name suffix — read before clustering so new
  //    "Person N" rows extend the sequence rather than collide.
  const maxAutoIndex = await maxAutoNameIndex();

  // 4. Load every unassigned face's embedding (decode + normalise here).
  const faces = await loadUnassignedFaces();

  // 5. Synchronous O(N·K·D) clustering pass over the embeddings.
  const seeds: ClusterSeed[] = centroids.map((c) => ({
    centroid: c.centroid,
    face_count: c.face_count,
  }));
  const result = clusterEmbeddings(
    faces.map((f) => f.embedding),
    { similarityThreshold, seeds },
  );

  return {
    seedCount: centroids.length,
    seedPersonIds: centroids.map((c) => c.person_id_hex),
    assignments: result.assignments,
    clusters: result.clusters.map((c) => ({
      centroid: Array.from(c.centroid),
      face_count: c.face_count,
    })),
    faces: faces.map((f) => ({
      asset_id_hex: f.asset_id_hex,
      face_index: f.face_index,
      bbox: f.bbox,
    })),
    maxAutoIndex,
    recomputed,
  };
}

// ---------------------------------------------------------------------------
// Internals — the per-row decode/normalize work the pass is built on.
// ---------------------------------------------------------------------------

/** An unassigned face WITH its loaded, normalised embedding — internal to
 * this module so the embedding never escapes into a serialized result. */
interface LoadedFace extends FaceEnvelope {
  embedding: Float32Array;
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
  // Seed query is intentionally NOT filtered on `hidden`: a hidden (soft-
  // deleted) person must remain a clustering seed so its newly-detected
  // matching faces keep flowing into it and it STAYS hidden, rather than
  // reforming as a fresh visible "Person N". Do not add a `hidden` filter
  // here — see `hidePerson` in people.repo.ts.
  const livePeople = await peopleC.find({ merged_into: null } as Filter<PersonDoc>).toArray();
  let updated = 0;
  const bulkOps: AnyBulkWriteOperation<PersonDoc>[] = [];

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
      // Skip if already clear to avoid a write on every repeat run.
      if (person.centroid_face_count === 0 && (!person.centroid || person.centroid.length === 0)) {
        continue;
      }
      bulkOps.push({
        updateOne: {
          filter: { _id: person._id },
          update: { $set: { centroid: [], centroid_face_count: 0 } },
        },
      });
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
    bulkOps.push({
      updateOne: {
        filter: { _id: person._id },
        update: {
          $set: {
            centroid: Array.from(normalised),
            centroid_face_count: count,
          },
        },
      },
    });
    updated += 1;
  }

  if (bulkOps.length > 0) {
    await peopleC.bulkWrite(bulkOps);
  }

  return updated;
}

export async function loadCentroids(): Promise<LoadedCentroid[]> {
  const peopleC = await peopleCollection();
  // Seed query is intentionally NOT filtered on `hidden`: hidden persons
  // stay clustering seeds so their new faces keep being absorbed (the person
  // stays hidden) instead of spawning a new visible cluster. Do not add a
  // `hidden` filter here — see `hidePerson` in people.repo.ts.
  const rows = await peopleC.find({ merged_into: null } as Filter<PersonDoc>).toArray();
  const out: LoadedCentroid[] = [];
  for (const r of rows) {
    if (!r.centroid || r.centroid.length !== EMBEDDING_DIM) continue;
    out.push({
      person_id_hex: r._id.toHexString(),
      centroid: l2Normalise(Float32Array.from(r.centroid)),
      face_count: r.centroid_face_count ?? 0,
    });
  }
  return out;
}

export async function loadUnassignedFaces(): Promise<LoadedFace[]> {
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
  const out: LoadedFace[] = [];
  for await (const row of cursor) {
    if (!Array.isArray(row.embedding) || row.embedding.length !== EMBEDDING_DIM) continue;
    out.push({
      asset_id_hex: row._id.toHexString(),
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
export async function maxAutoNameIndex(): Promise<number> {
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
