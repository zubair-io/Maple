/**
 * Pure-function clustering core. Extracted from `clustering-job.ts` so the
 * face-clustering quality harness (`src/scripts/test_face_clustering.sh`)
 * can score the algorithm on a labelled fixture set without standing up
 * MongoDB.
 *
 * The DB-backed `runOnlineClustering` (in `clustering-job.ts`) is a thin
 * wrapper that loads centroids from Mongo, calls into here, and writes
 * the results. Splitting the math out keeps clustering-job.ts under the
 * 600-LOC budget and lets the harness import this module directly.
 *
 * Determinism: order-sensitive (online, not batch) — the first face to
 * land far from every centroid opens a new cluster, and subsequent faces
 * compete against that cluster too. Pass embeddings in the order you
 * want processed; the harness uses the order in `embeddings.jsonl`.
 * Ties between two clusters with equal score break by cluster-id order
 * (lowest wins) — same rule as the DB-backed path where `for (const c of
 * centroids)` preserves load order.
 */

/** Online-clustering default. 0.5 chosen empirically: MobileFaceNet
 * embeddings tend to score 0.6-0.9 within an identity and < 0.4 across.
 * Operators can override at call time when triaging a noisy library. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

/** Embedding dimensionality from MobileFaceNet — used as a sanity-check
 * downstream when reading embeddings from Mongo or the fixture JSONL. */
export const EMBEDDING_DIM = 512;

// ---------------------------------------------------------------------------
// Vector helpers (cosine-similarity primitives, used everywhere downstream)
// ---------------------------------------------------------------------------

/** L2-normalise into a fresh Float32Array. A zero vector returns zeros
 * (no NaN); the dot product against a zero vector is 0, which keeps the
 * "not similar" semantics intact. */
export function l2Normalise(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i += 1) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return new Float32Array(v.length);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / norm;
  return out;
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/** Streaming mean: c' = ((c * n) + e) / (n + 1). Renormalises before
 * returning so the centroid stays unit-length for the cosine path. */
export function updateCentroid(
  centroid: Float32Array,
  embedding: Float32Array,
  count: number,
): Float32Array {
  if (centroid.length !== embedding.length) return centroid;
  const out = new Float32Array(centroid.length);
  for (let i = 0; i < centroid.length; i += 1) {
    out[i] = (centroid[i] * count + embedding[i]) / (count + 1);
  }
  return l2Normalise(out);
}

// ---------------------------------------------------------------------------
// Pure online-clustering pass
// ---------------------------------------------------------------------------

/** An existing cluster (centroid + member count) passed into the core
 * when seeding from prior runs. The core returns an updated array of
 * these by value — original is not mutated. */
export interface ClusterSeed {
  /** L2-normalised centroid. */
  centroid: Float32Array;
  /** Number of embeddings already in the cluster (drives streaming mean). */
  face_count: number;
}

export interface OnlineClusterOptions {
  /** Cosine threshold to merge into an existing cluster. Default
   * `DEFAULT_SIMILARITY_THRESHOLD` (0.5). */
  similarityThreshold?: number;
  /** Existing clusters to match against (e.g. centroids loaded from the
   * DB). Cluster ids in the returned `assignments` array correspond to
   * indices in `seeds.concat(newClusters)`. */
  seeds?: ClusterSeed[];
}

export interface OnlineClusterResult {
  /** `assignments[i]` is the integer cluster id for input embedding `i`.
   * Ids in `[0, seeds.length)` reference pre-existing seeds; ids ≥
   * `seeds.length` reference newly-created clusters. */
  assignments: number[];
  /** Best matching score (cosine similarity) per input. Useful for
   * debugging / metric attribution. */
  scores: number[];
  /** Whether the assignment for input `i` reused an existing seed (true)
   * or spawned a fresh cluster (false). Length equals `assignments`. */
  reusedSeed: boolean[];
  /** Updated copies of every seed (mutated by streaming-mean updates),
   * followed by any new clusters created during this pass. */
  clusters: ClusterSeed[];
  /** How many of the returned clusters were newly created (i.e.
   * `clusters.length - seeds.length`). */
  newClusters: number;
}

/**
 * Pure online-clustering pass. Assigns every embedding to its nearest
 * existing centroid under cosine similarity if the best score meets
 * `similarityThreshold`, otherwise opens a new cluster seeded by the
 * embedding.
 *
 * No side effects, no Mongo, no logging. The DB-backed `runOnlineClustering`
 * wraps this and applies the assignments to asset/person documents.
 */
export function clusterEmbeddings(
  embeddings: Float32Array[],
  options: OnlineClusterOptions = {},
): OnlineClusterResult {
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  // Defensive copy so callers can reuse their seed array safely.
  const clusters: ClusterSeed[] = (options.seeds ?? []).map((s) => ({
    centroid: l2Normalise(s.centroid),
    face_count: s.face_count,
  }));
  const seedCount = clusters.length;

  const assignments: number[] = new Array(embeddings.length).fill(-1);
  const scores: number[] = new Array(embeddings.length).fill(0);
  const reusedSeed: boolean[] = new Array(embeddings.length).fill(false);

  for (let i = 0; i < embeddings.length; i += 1) {
    const face = l2Normalise(embeddings[i]);
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let k = 0; k < clusters.length; k += 1) {
      const score = dotProduct(face, clusters[k].centroid);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = k;
      }
    }
    if (bestIdx >= 0 && bestScore >= threshold) {
      clusters[bestIdx].centroid = updateCentroid(
        clusters[bestIdx].centroid,
        face,
        clusters[bestIdx].face_count,
      );
      clusters[bestIdx].face_count += 1;
      assignments[i] = bestIdx;
      scores[i] = bestScore;
      reusedSeed[i] = bestIdx < seedCount;
      continue;
    }
    // No good match — open a new cluster seeded by this embedding.
    const newIdx = clusters.length;
    clusters.push({ centroid: face, face_count: 1 });
    assignments[i] = newIdx;
    scores[i] = bestScore === -Infinity ? 0 : bestScore;
    reusedSeed[i] = false;
  }

  return {
    assignments,
    scores,
    reusedSeed,
    clusters,
    newClusters: clusters.length - seedCount,
  };
}
