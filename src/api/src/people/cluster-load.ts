/**
 * The clustering LOAD + COMPUTE stage — every O(N·D) pass over the embedding
 * set: the per-row decode + `l2Normalise` that turns stored vectors into
 * comparable ones, the per-centroid mean accumulation in `recomputeCentroids`,
 * and the synchronous `clusterEmbeddings` pass itself.
 *
 * The work runs on the clustering worker rather than the HTTP thread, and the
 * implementation is `db/sqlite/repos/people.cluster-load.ts`. Its order is the
 * contract — recompute → load centroids → read the auto-name high-water mark →
 * load unassigned faces → cluster — and `recomputeCentroids` deliberately
 * writes the normalised centroid back for `loadCentroids` to re-read and
 * re-normalise. Fusing the two would shift the last bits of each component,
 * which is enough to flip an assignment whose cosine score sits near the 0.5
 * threshold.
 *
 * ## Why the result shapes stay here
 *
 * The SQLite module imports the five interfaces below rather than redeclaring
 * them, so the two stages cannot drift apart in structure while claiming to be
 * interchangeable. Those are type-only imports and erase at build time, so the
 * edge back to this file costs the worker nothing at runtime — which matters,
 * because anything the worker's import graph can reach must stay free of a
 * logger (see `db/sqlite/pool.ts`).
 *
 * `clustering-job.ts` keeps every WRITE-side concern (person creation,
 * assignment buffering, centroid persistence, cover backfill, meili reindex).
 */

import type { Bbox } from '../db/schema.ts';
import type { MergeSuggestion } from './people-merge-suggestions.ts';

/** A loaded centroid, ready to seed the clustering pass. The `person_id` is
 * kept as a hex string so the whole structure is `postMessage`-serializable
 * when the load runs on the worker. */
export interface LoadedCentroid {
  person_id_hex: string;
  /** L2-normalised — cosine similarity is then a dot product. */
  centroid: Float32Array;
  /** Number of faces that contributed to the running mean. */
  face_count: number;
  /** True for a soft-hidden person. Carried so the merge-suggestion pass
   * can exclude hidden people without a second query — clustering itself
   * deliberately does NOT filter on `hidden` (see the module header), this
   * field exists only for that second, narrower use. */
  hidden: boolean;
  /** True for an excluded person (#2894) — same carried-for-suggestions-only
   * rationale as `hidden`; clustering itself stays unfiltered. */
  excluded: boolean;
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
  /** Merge-suggestion pass over the loaded centroids (§ person-page merge
   * suggestions). One entry per person with a qualifying suggestion;
   * absent entries mean "no suggestion" — the write side (`clustering-
   * job.ts`) explicitly clears anyone not present here. */
  mergeSuggestions: MergeSuggestion[];
}
