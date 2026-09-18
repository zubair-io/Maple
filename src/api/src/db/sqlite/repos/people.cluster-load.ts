/**
 * The clustering LOAD + COMPUTE stage against SQLite (#3749) — the port of
 * `people/cluster-load.ts`.
 *
 * This module owns every O(N·D) pass over the embedding set: decoding and
 * normalising each stored vector, accumulating the per-person mean in
 * `recomputeCentroids`, and the synchronous O(N·K·D) `clusterEmbeddings` pass
 * itself. It is the one place embeddings are touched, which is why it runs on
 * the clustering worker rather than the request thread.
 *
 * ## The order is the contract
 *
 * recompute → load centroids → read the auto-name high-water mark → load
 * unassigned faces → cluster. Two details inside that sequence are not
 * incidental:
 *
 * `recomputeCentroids` **writes** the normalised centroid back, and
 * `loadCentroids` then **re-reads and re-normalises** it. Fusing the two would
 * be the obvious optimisation and is deliberately not done: normalising twice
 * is part of the existing numeric path, and dropping the second pass shifts the
 * last few bits of each component — enough to flip an assignment whose cosine
 * score sits near the 0.5 threshold. The write therefore has to be committed
 * and visible before the read, which is what makes the worker's database
 * arrangement load-bearing rather than a detail; see `worker-db.ts`.
 *
 * The seed order decides what a cluster id means, since ids are positions in
 * the seed list, and online clustering is order-sensitive besides — a face
 * competes against every cluster opened by the faces before it. Both queries
 * that feed the pass therefore carry an explicit `ORDER BY`.
 *
 * ## What crosses back
 *
 * Only assignments, updated centroids and per-face envelopes. The embeddings
 * stay inside this module by construction: `LoadedFace` is not exported, and
 * `PreparedClusteringPass` has no field that could carry one.
 */

import {
  clusterEmbeddings,
  DEFAULT_SIMILARITY_THRESHOLD,
  EMBEDDING_DIM,
  l2Normalise,
  type ClusterSeed,
} from '../../../people/cluster-embeddings.ts';
import { computeMergeSuggestions } from '../../../people/people-merge-suggestions.ts';
import type { SqlStatement } from '../protocol.ts';
import { peopleDb, type SqliteDb } from './db-handle.ts';
import { loadMergeDismissals } from './people.merge-suggestions.ts';
import {
  assignedEmbeddingsSql,
  LIVE_CENTROIDS_SQL,
  MAX_AUTO_NAME_INDEX_SQL,
  SET_CENTROID_SQL,
  UNASSIGNED_FACES_SQL,
} from './people.sql.ts';
import type { Bbox } from '../../schema.ts';

/**
 * The result shapes are imported from the Mongo module rather than redeclared,
 * so the two stages cannot drift apart in structure while claiming to be
 * interchangeable. These are type-only imports and erase at build time, so
 * nothing in `cluster-load.ts` — the Mongo driver included — is loaded here.
 */
import type {
  FaceEnvelope,
  LoadedCentroid,
  PreparedClusteringPass,
  SerializedCluster,
} from '../../../people/cluster-load.ts';

export type { FaceEnvelope, LoadedCentroid, PreparedClusteringPass, SerializedCluster };
export { EMBEDDING_DIM } from '../../../people/cluster-embeddings.ts';

/** An unassigned face with its embedding. Not exported — see the module header. */
interface LoadedFace extends FaceEnvelope {
  embedding: Float32Array;
}

interface CentroidRow {
  id: string;
  centroid: string | null;
  centroid_face_count: number | null;
  hidden: number;
  excluded: number;
}

interface EmbeddingRow {
  person_id: string;
  embedding: string | null;
}

interface UnassignedFaceRow {
  asset_id: string;
  face_index: number;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  embedding: string | null;
}

/**
 * How many ids one `IN (…)` carries when reading the dirty people's embeddings.
 *
 * A first pass on a production-sized library has every one of ~25,800 people
 * dirty, and a single `IN` list that long runs into SQLite's bound-parameter
 * ceiling and produces a statement text no cache can reuse. Chunking fixes
 * both, and the last chunk is padded by repeating its final id — harmless
 * inside an `IN`, and it means every chunk compiles to the *same* statement, so
 * the prepared-statement cache holds one entry instead of one per library size.
 */
const EMBEDDING_CHUNK = 500;

/** A JSON-encoded vector as numbers, or null when the column is absent or malformed. */
function decodeArray(text: string | null): number[] | null {
  if (text === null) return null;
  try {
    const values = JSON.parse(text) as unknown;
    return Array.isArray(values) ? (values as number[]) : null;
  } catch {
    return null;
  }
}

/** A JSON-encoded embedding as a vector, or null when it is absent or the wrong shape. */
function decodeVector(text: string | null): Float32Array | null {
  const values = decodeArray(text);
  if (values === null || values.length !== EMBEDDING_DIM) return null;
  return Float32Array.from(values);
}

/**
 * The canonical "this person has no assigned faces" centroid.
 *
 * Checked by decoding rather than by comparing the text to `'[]'`: the importer
 * and an operator's own SQL can both produce a differently spaced but equally
 * empty array, and treating those as "not yet cleared" would leave the row
 * dirty on every pass forever.
 */
function isClearedCentroid(text: string | null): boolean {
  return decodeArray(text)?.length === 0;
}

/**
 * Run the full load + compute stage.
 *
 * Runs either on the clustering worker, against the handle described in
 * `worker-db.ts`, or in-process against the pool when no worker can spawn.
 * Both produce the same output: the same functions run in the same order over
 * the same rows.
 */
export async function prepareClusteringPass(
  similarityThreshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  dbOverride?: SqliteDb,
): Promise<PreparedClusteringPass> {
  const db = peopleDb(dbOverride);

  // 1. Refresh stored centroids from the current assignments, and commit.
  const recomputed = await recomputeCentroids(db);

  // 2. Re-read them as seeds. The second normalise is deliberate — see header.
  const centroids = await loadCentroids(db);

  // 3. The auto-name high-water mark, read before clustering so new rows extend
  //    the sequence rather than collide with a name this pass is about to mint.
  const maxAutoIndex = await maxAutoNameIndex(db);

  // 4. Every unassigned face's embedding, decoded and normalised here.
  const faces = await loadUnassignedFaces(db);

  // 5. The synchronous O(N·K·D) pass.
  const seeds: ClusterSeed[] = centroids.map((centroid) => ({
    centroid: centroid.centroid,
    face_count: centroid.face_count,
  }));
  const result = clusterEmbeddings(
    faces.map((face) => face.embedding),
    { similarityThreshold, seeds },
  );

  // The merge-suggestion pass reuses the centroids already loaded; the only
  // extra read is the dismissal set.
  const dismissedPairs = await loadMergeDismissals(db);
  const mergeSuggestions = computeMergeSuggestions(
    centroids.map((centroid) => ({
      personIdHex: centroid.person_id_hex,
      centroid: centroid.centroid,
      hidden: centroid.hidden,
      excluded: centroid.excluded,
    })),
    dismissedPairs,
  );

  return {
    seedCount: centroids.length,
    seedPersonIds: centroids.map((centroid) => centroid.person_id_hex),
    assignments: result.assignments,
    clusters: result.clusters.map((cluster) => ({
      centroid: Array.from(cluster.centroid),
      face_count: cluster.face_count,
    })),
    faces: faces.map((face) => ({
      asset_id_hex: face.asset_id_hex,
      face_index: face.face_index,
      bbox: face.bbox,
    })),
    maxAutoIndex,
    recomputed,
    mergeSuggestions,
  };
}

/**
 * Which people need their stored centroid rebuilt.
 *
 * Three states qualify, and the third is a repair rather than a refresh: a
 * positive count alongside a missing or truncated vector is a stuck row (#2105)
 * that is invisible to both this check — a positive count reads as clean — and
 * to `loadCentroids`, which cannot seed from a short vector. Left alone its
 * centroid never rebuilds and any stale merge suggestion never clears.
 *
 * An empty vector with a zero count is deliberately *not* dirty: that is the
 * valid "no faces assigned" state, and treating it as dirty would keep every
 * manually created person perpetually in the rebuild set.
 */
function isDirty(row: CentroidRow): boolean {
  const count = row.centroid_face_count;
  if (count === null || count === -1) return true;
  if (count <= 0) return false;
  return decodeVector(row.centroid) === null;
}

/** Read every dirty person's unhidden embeddings, in bounded chunks. */
async function readAssignedEmbeddings(
  db: SqliteDb,
  dirtyIds: readonly string[],
): Promise<EmbeddingRow[]> {
  const sql = assignedEmbeddingsSql(EMBEDDING_CHUNK);
  const chunks: Array<Promise<EmbeddingRow[]>> = [];
  for (let start = 0; start < dirtyIds.length; start += EMBEDDING_CHUNK) {
    const slice = dirtyIds.slice(start, start + EMBEDDING_CHUNK);
    const last = slice[slice.length - 1]!;
    const padded = [...slice, ...new Array(EMBEDDING_CHUNK - slice.length).fill(last)];
    chunks.push(db.read<EmbeddingRow>(sql, padded));
  }
  const results = await Promise.all(chunks);
  return results.flat();
}

/**
 * Rebuild every dirty person's centroid as the L2-normalised mean of their
 * unhidden assigned embeddings, and write the changes back.
 *
 * Returns how many people were updated — the number the standalone
 * `recomputeCentroids` export has always yielded.
 *
 * Unchanged centroids are skipped, so a repeat pass over a settled library
 * writes nothing. "Unchanged" compares component-wise against a 1e-7 tolerance
 * rather than exactly, because the mean is accumulated in a different order
 * than last time whenever a face was added or removed.
 */
export async function recomputeCentroids(dbOverride?: SqliteDb): Promise<number> {
  const db = peopleDb(dbOverride);
  const rows = await db.read<CentroidRow>(LIVE_CENTROIDS_SQL);
  const dirty = rows.filter(isDirty);
  if (dirty.length === 0) return 0;

  const embeddings = await readAssignedEmbeddings(
    db,
    dirty.map((row) => row.id),
  );
  const wanted = new Set(dirty.map((row) => row.id));
  const accumulators = new Map<string, { count: number; mean: Float32Array }>();
  for (const row of embeddings) {
    if (!wanted.has(row.person_id)) continue;
    const vector = decodeVector(row.embedding);
    if (!vector) continue;
    const existing = accumulators.get(row.person_id);
    const accumulator = existing ?? { count: 0, mean: new Float32Array(EMBEDDING_DIM) };
    if (!existing) accumulators.set(row.person_id, accumulator);
    for (let i = 0; i < EMBEDDING_DIM; i += 1) accumulator.mean[i] += vector[i]!;
    accumulator.count += 1;
  }

  const updates: SqlStatement[] = [];
  for (const row of dirty) {
    const accumulator = accumulators.get(row.id);
    const stored = decodeVector(row.centroid);

    if (!accumulator || accumulator.count === 0) {
      // Nobody assigned, or only hidden faces. Clear to the canonical empty
      // state — unless the row is already in it, in which case there is
      // nothing to write and nothing left dirty.
      if (row.centroid_face_count === 0 && isClearedCentroid(row.centroid)) continue;
      updates.push({ sql: SET_CENTROID_SQL, params: ['[]', 0, row.id] });
      continue;
    }

    for (let i = 0; i < EMBEDDING_DIM; i += 1) accumulator.mean[i] /= accumulator.count;
    const normalised = l2Normalise(accumulator.mean);

    if (row.centroid_face_count === accumulator.count && stored !== null) {
      const drifted = stored.some((value, i) => Math.abs(value - normalised[i]!) > 1e-7);
      if (!drifted) continue;
    }
    updates.push({
      sql: SET_CENTROID_SQL,
      params: [JSON.stringify(Array.from(normalised)), accumulator.count, row.id],
    });
  }

  if (updates.length > 0) await db.transaction(updates);
  return updates.length;
}

/**
 * Every un-merged person's centroid, re-normalised, as a clustering seed.
 *
 * Rows whose vector is absent or the wrong length are skipped: there is nothing
 * to seed from, and `recomputeCentroids` has already had its chance to repair
 * them on this same pass.
 */
export async function loadCentroids(dbOverride?: SqliteDb): Promise<LoadedCentroid[]> {
  const db = peopleDb(dbOverride);
  const rows = await db.read<CentroidRow>(LIVE_CENTROIDS_SQL);
  return rows.flatMap((row) => {
    const vector = decodeVector(row.centroid);
    if (!vector) return [];
    return [
      {
        person_id_hex: row.id,
        centroid: l2Normalise(vector),
        face_count: row.centroid_face_count ?? 0,
        hidden: row.hidden === 1,
        excluded: row.excluded === 1,
      },
    ];
  });
}

/**
 * Every unassigned, unhidden face carrying a usable embedding, normalised.
 *
 * Hidden faces stay out: re-running clustering must not quietly reassign a face
 * the operator removed from the system.
 */
export async function loadUnassignedFaces(dbOverride?: SqliteDb): Promise<LoadedFace[]> {
  const db = peopleDb(dbOverride);
  const rows = await db.read<UnassignedFaceRow>(UNASSIGNED_FACES_SQL);
  return rows.flatMap((row) => {
    const vector = decodeVector(row.embedding);
    if (!vector) return [];
    const bbox: Bbox = { x: row.bbox_x, y: row.bbox_y, w: row.bbox_w, h: row.bbox_h };
    return [
      {
        asset_id_hex: row.asset_id,
        face_index: row.face_index,
        embedding: l2Normalise(vector),
        bbox,
      },
    ];
  });
}

/**
 * The highest "Person N" suffix in use, so new auto-names extend the run rather
 * than collide. Zero when no auto-named person exists.
 */
export async function maxAutoNameIndex(dbOverride?: SqliteDb): Promise<number> {
  const db = peopleDb(dbOverride);
  const rows = await db.read<{ max_index: number | null }>(MAX_AUTO_NAME_INDEX_SQL);
  const max = rows[0]?.max_index ?? null;
  return max === null || !Number.isFinite(max) ? 0 : max;
}

export { loadMergeDismissals } from './people.merge-suggestions.ts';
