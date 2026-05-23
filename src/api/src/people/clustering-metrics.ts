/**
 * Face-clustering quality metrics.
 *
 * Pure, deterministic functions that compare a predicted clustering against
 * a ground-truth identity labelling. Used by the parity harness at
 * `src/scripts/test_face_clustering.sh` to gate clustering-algorithm
 * changes against committed quality budgets, in the same spirit as the
 * color-pipeline harness (`src/scripts/test_color_pipeline.sh`).
 *
 * All functions take two parallel arrays of length `n`:
 *   - `predicted[i]` is the cluster id assigned to face `i` (any int).
 *   - `truth[i]`     is the ground-truth identity label for face `i` (any
 *                    string — typically a person name from LFW or a
 *                    synthetic "person_A" tag).
 *
 * Reference definitions follow Manning, Raghavan, Schütze "Introduction to
 * Information Retrieval" §16 (purity, NMI) and Hubert & Arabie 1985 (ARI).
 * The V-measure follows Rosenberg & Hirschberg 2007.
 *
 * Numerical conventions:
 *   - Edge cases (empty input, single cluster, single class) return 1.0 for
 *     metrics where that is the conventional value (purity, NMI, V) so they
 *     fail safe rather than NaN. ARI returns 0 when the chance-corrected
 *     denominator collapses — this matches scikit-learn's behaviour.
 *   - Log base is natural log for entropy; the NMI ratio cancels the base
 *     so the choice does not affect the returned value.
 */

// ---------------------------------------------------------------------------
// Contingency table helper
// ---------------------------------------------------------------------------

interface Contingency {
  /** Pair counts: `table[clusterIdx][classIdx]`. */
  table: number[][];
  /** Row sums (per predicted cluster). */
  clusterTotals: number[];
  /** Column sums (per ground-truth class). */
  classTotals: number[];
  /** Total number of items (n). */
  n: number;
  /** Cluster id -> dense index (row in `table`). */
  clusterIndex: Map<number, number>;
  /** Class label -> dense index (column in `table`). */
  classIndex: Map<string, number>;
}

function buildContingency(predicted: number[], truth: string[]): Contingency {
  if (predicted.length !== truth.length) {
    throw new Error(
      `clustering-metrics: predicted (${predicted.length}) and truth (${truth.length}) must have equal length`,
    );
  }
  const clusterIndex = new Map<number, number>();
  const classIndex = new Map<string, number>();
  const n = predicted.length;
  // First pass: discover unique cluster ids + class labels in stable order.
  for (let i = 0; i < n; i += 1) {
    if (!clusterIndex.has(predicted[i])) clusterIndex.set(predicted[i], clusterIndex.size);
    if (!classIndex.has(truth[i])) classIndex.set(truth[i], classIndex.size);
  }
  const nClusters = clusterIndex.size;
  const nClasses = classIndex.size;
  const table: number[][] = Array.from({ length: nClusters }, () =>
    new Array<number>(nClasses).fill(0),
  );
  const clusterTotals = new Array<number>(nClusters).fill(0);
  const classTotals = new Array<number>(nClasses).fill(0);
  for (let i = 0; i < n; i += 1) {
    const r = clusterIndex.get(predicted[i])!;
    const c = classIndex.get(truth[i])!;
    table[r][c] += 1;
    clusterTotals[r] += 1;
    classTotals[c] += 1;
  }
  return { table, clusterTotals, classTotals, n, clusterIndex, classIndex };
}

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

/**
 * Purity — fraction of items whose predicted cluster majority class matches
 * their true label.
 *
 *   purity(C, T) = (1/n) * Σ_k max_j |C_k ∩ T_j|
 *
 * Range [0, 1]. Trivially 1.0 when every face is its own cluster — pair
 * with NMI / ARI / V-measure to penalise over-fragmentation.
 *
 * Returns 1.0 for `n == 0` (vacuously perfect, fail-safe — no NaN downstream).
 */
export function purity(predicted: number[], truth: string[]): number {
  if (predicted.length === 0) return 1;
  const { table, n } = buildContingency(predicted, truth);
  let majoritySum = 0;
  for (const row of table) {
    let best = 0;
    for (const v of row) if (v > best) best = v;
    majoritySum += best;
  }
  return majoritySum / n;
}

// ---------------------------------------------------------------------------
// Mutual information & NMI
// ---------------------------------------------------------------------------

/** Natural-log entropy of a discrete distribution given the absolute counts
 * and their total. 0 * log(0) = 0 by convention. */
function entropyFromCounts(counts: number[], n: number): number {
  if (n === 0) return 0;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / n;
    h -= p * Math.log(p);
  }
  return h;
}

/** Mutual information I(C; T) from the contingency table. */
function mutualInformationFromTable(table: Contingency): number {
  const { table: t, clusterTotals, classTotals, n } = table;
  if (n === 0) return 0;
  let mi = 0;
  for (let i = 0; i < t.length; i += 1) {
    for (let j = 0; j < t[i].length; j += 1) {
      const nij = t[i][j];
      if (nij <= 0) continue;
      const num = nij * n;
      const den = clusterTotals[i] * classTotals[j];
      mi += (nij / n) * Math.log(num / den);
    }
  }
  return mi;
}

/**
 * Normalised mutual information using the arithmetic-mean normaliser
 * (the scikit-learn default):
 *
 *   NMI = I(C; T) / ((H(C) + H(T)) / 2)
 *
 * Range [0, 1]. Returns 1.0 when both labellings have at most one
 * non-trivial group (degenerate but well-defined as "fully agree").
 */
export function normalizedMutualInformation(predicted: number[], truth: string[]): number {
  if (predicted.length === 0) return 1;
  const ct = buildContingency(predicted, truth);
  const hC = entropyFromCounts(ct.clusterTotals, ct.n);
  const hT = entropyFromCounts(ct.classTotals, ct.n);
  const denom = (hC + hT) / 2;
  if (denom <= 0) return 1; // both labellings have zero entropy — degenerate match.
  const mi = mutualInformationFromTable(ct);
  const nmi = mi / denom;
  // Clamp tiny FP drift around 0/1 boundaries so callers can budget cleanly.
  if (nmi < 0) return 0;
  if (nmi > 1) return 1;
  return nmi;
}

// ---------------------------------------------------------------------------
// V-measure
// ---------------------------------------------------------------------------

/**
 * V-measure (Rosenberg & Hirschberg 2007). Harmonic mean of:
 *   homogeneity   h = 1 - H(T|C)/H(T)     "each cluster is one class"
 *   completeness  c = 1 - H(C|T)/H(C)     "each class is one cluster"
 *
 *   V_β = (1 + β) * h * c / (β * h + c)
 *
 * `beta > 1` weights completeness, `beta < 1` weights homogeneity. Default
 * `beta = 1` gives the symmetric harmonic mean used by scikit-learn's
 * `v_measure_score`.
 *
 * Note: `vMeasure(...) === normalizedMutualInformation(...)` when both are
 * computed with the "harmonic" normaliser — we use the arithmetic-mean
 * normaliser for NMI above so the two metrics are NOT identical in this
 * library and are worth tracking separately.
 */
export function vMeasure(predicted: number[], truth: string[], beta = 1): number {
  if (predicted.length === 0) return 1;
  const ct = buildContingency(predicted, truth);
  const hC = entropyFromCounts(ct.clusterTotals, ct.n);
  const hT = entropyFromCounts(ct.classTotals, ct.n);
  const mi = mutualInformationFromTable(ct);
  // H(T|C) = H(T) - I(C;T); H(C|T) = H(C) - I(C;T).
  const homogeneity = hT > 0 ? mi / hT : 1;
  const completeness = hC > 0 ? mi / hC : 1;
  if (homogeneity <= 0 && completeness <= 0) return 0;
  const num = (1 + beta) * homogeneity * completeness;
  const den = beta * homogeneity + completeness;
  if (den <= 0) return 0;
  const v = num / den;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// ---------------------------------------------------------------------------
// Adjusted Rand index
// ---------------------------------------------------------------------------

/** Number of unordered pairs in a group of size `k`: k*(k-1)/2. */
function pairs(k: number): number {
  if (k < 2) return 0;
  return (k * (k - 1)) / 2;
}

/**
 * Adjusted Rand index (Hubert & Arabie 1985). Chance-corrected agreement
 * between two partitions:
 *
 *   ARI = (RI - E[RI]) / (max(RI) - E[RI])
 *
 * Where RI counts pair agreements (both-together or both-apart in each
 * partition). Range [-1, 1]; 0 ≈ random, 1 = perfect, < 0 = worse than
 * chance. Returns 0 when the expected-index normaliser collapses (e.g. all
 * items in one cluster or one class), matching scikit-learn.
 */
export function adjustedRandIndex(predicted: number[], truth: string[]): number {
  if (predicted.length === 0) return 1;
  const ct = buildContingency(predicted, truth);
  const { table, clusterTotals, classTotals, n } = ct;
  if (n < 2) return 1;
  let index = 0;
  for (const row of table) {
    for (const v of row) index += pairs(v);
  }
  let sumA = 0;
  for (const a of clusterTotals) sumA += pairs(a);
  let sumB = 0;
  for (const b of classTotals) sumB += pairs(b);
  const totalPairs = pairs(n);
  const expectedIndex = totalPairs > 0 ? (sumA * sumB) / totalPairs : 0;
  const maxIndex = (sumA + sumB) / 2;
  const denom = maxIndex - expectedIndex;
  if (denom === 0) return 0; // degenerate — both partitions are trivial.
  const ari = (index - expectedIndex) / denom;
  if (ari < -1) return -1;
  if (ari > 1) return 1;
  return ari;
}

// ---------------------------------------------------------------------------
// Identity recall@1
// ---------------------------------------------------------------------------

/**
 * Identity recall@1 — fraction of faces whose nearest **same-cluster**
 * neighbour shares the true identity.
 *
 * For each face i in cluster C_k with at least one other face in C_k, look
 * up that other face's truth label and compare against `truth[i]`. The
 * "nearest" here is operationally "any other member of the same cluster" —
 * since the predicted clustering already groups by similarity, this
 * reduces to: of the faces I'm placed next to, do they actually share my
 * identity?
 *
 * For multi-member clusters we take the **majority** other-member label
 * (excluding the face itself) and check whether that majority matches the
 * face's true label. This is robust against a small number of injected
 * impostors in an otherwise-correct cluster.
 *
 * Singletons (faces alone in a cluster) are counted as recall=0 for that
 * face — being alone is failure to find a same-identity neighbour. This
 * matches the standard "rank-1 retrieval against same-cluster gallery"
 * definition and penalises over-fragmentation.
 *
 * Range [0, 1]. Returns 1.0 for `n == 0`.
 */
export function recallAt1(predicted: number[], truth: string[]): number {
  if (predicted.length === 0) return 1;
  const ct = buildContingency(predicted, truth);
  const { table, clusterTotals, n, clusterIndex, classIndex } = ct;
  const reverseClassIndex = new Map<number, string>();
  for (const [label, idx] of classIndex) reverseClassIndex.set(idx, label);

  let hits = 0;
  for (let i = 0; i < n; i += 1) {
    const r = clusterIndex.get(predicted[i])!;
    const c = classIndex.get(truth[i])!;
    const clusterSize = clusterTotals[r];
    if (clusterSize <= 1) continue; // singleton → recall = 0 for this face.
    // Majority of OTHER members of this cluster — subtract self from own column.
    let best = -1;
    let bestLabelIdx = -1;
    for (let j = 0; j < table[r].length; j += 1) {
      const count = j === c ? table[r][j] - 1 : table[r][j];
      if (count > best) {
        best = count;
        bestLabelIdx = j;
      }
    }
    if (bestLabelIdx === c && best > 0) hits += 1;
  }
  return hits / n;
}

// ---------------------------------------------------------------------------
// Convenience: compute everything at once
// ---------------------------------------------------------------------------

export interface ClusteringMetrics {
  purity: number;
  nmi: number;
  v_measure: number;
  ari: number;
  recall_at_1: number;
  /** Number of items scored. */
  n: number;
  /** Number of distinct predicted clusters. */
  n_clusters_pred: number;
  /** Number of distinct ground-truth classes. */
  n_classes_true: number;
}

export function allMetrics(predicted: number[], truth: string[]): ClusteringMetrics {
  const ct = buildContingency(predicted, truth);
  return {
    purity: purity(predicted, truth),
    nmi: normalizedMutualInformation(predicted, truth),
    v_measure: vMeasure(predicted, truth),
    ari: adjustedRandIndex(predicted, truth),
    recall_at_1: recallAt1(predicted, truth),
    n: ct.n,
    n_clusters_pred: ct.clusterIndex.size,
    n_classes_true: ct.classIndex.size,
  };
}
