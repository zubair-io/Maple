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

import {
  type Filter,
  ObjectId,
} from "mongodb";
import {
  assetsCollection,
  peopleCollection,
} from "../db/client.ts";
import type {
  AssetDoc,
  AssetFaceDoc,
  PersonDoc,
} from "../db/schema.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("people:clustering");

/** Online-clustering knob. 0.5 chosen empirically: MobileFaceNet
 * embeddings tend to score 0.6-0.9 within an identity and < 0.4 across.
 * Operators can override at call time when triaging a noisy library. */
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

/** Embedding dimensionality from MobileFaceNet. Used as a sanity check
 * when reading embeddings from Mongo. */
const EMBEDDING_DIM = 512;

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
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk every face that's missing a `person_id` and assign it to the
 * closest existing person (under cosine similarity, threshold default 0.5)
 * or create a new "Person N" cluster if no match is close enough.
 *
 * Idempotent: re-running with the same data assigns zero faces.
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

  let assigned = 0;
  let newPeople = 0;
  // Buffer assignments per (asset_id, face_index) so we can apply them
  // in a single bulk write per asset.
  const perAsset = new Map<string, { assetId: ObjectId; updates: Array<{ index: number; personId: string }> }>();

  for (const face of faces) {
    let bestId: ObjectId | null = null;
    let bestScore = -Infinity;
    for (const c of centroids) {
      const score = dotProduct(face.embedding, c.centroid);
      if (score > bestScore) {
        bestScore = score;
        bestId = c.person_id;
      }
    }
    if (bestId !== null && bestScore >= threshold) {
      const target = centroids.find((c) => c.person_id.equals(bestId!));
      if (target) {
        // Streaming mean: c' = (c * n + e) / (n + 1) followed by L2
        // renormalise so cosine == dot.
        target.centroid = updateCentroid(
          target.centroid,
          face.embedding,
          target.face_count,
        );
        target.face_count += 1;
      }
      bufferAssignment(perAsset, face, bestId.toHexString());
      assigned += 1;
      continue;
    }
    // No good match — spawn a new auto-named person seeded with this
    // face as the cover thumb.
    nextAutoIndex += 1;
    const name = `Person ${nextAutoIndex}`;
    const created = await createAutoPerson(name, face.embedding, face.asset_id);
    centroids.push({
      person_id: created,
      centroid: l2Normalise(face.embedding),
      face_count: 1,
    });
    bufferAssignment(perAsset, face, created.toHexString());
    assigned += 1;
    newPeople += 1;
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

  // Persist refreshed centroids so subsequent runs converge.
  await persistCentroids(centroids);

  // Backfill cover thumbs for any live person without one. Covers may be
  // missing on rows created before cover-seeding landed, or on people
  // created manually via `POST /api/people` ahead of any face assignment.
  await backfillCoverAssets();

  log.info(
    { assigned, newPeople, scanned: faces.length, threshold },
    "online clustering finished",
  );
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
  const livePeople = await peopleC
    .find({ merged_into: null } as Filter<PersonDoc>)
    .toArray();
  let updated = 0;
  for (const person of livePeople) {
    const personHex = person._id.toHexString();
    // Pull the embedding off every face assigned to this person. Two
    // $match stages around $unwind narrow each side: the first lets the
    // planner skip docs that don't have any matching face, and the
    // second drops the unwound rows whose `person_id` is for someone
    // else.
    const cursor = assets.aggregate<{ embedding: number[] }>([
      { $match: { "faces.person_id": personHex } },
      { $unwind: "$faces" },
      { $match: { "faces.person_id": personHex } },
      { $match: { "faces.embedding": { $exists: true, $ne: [] } } },
      { $project: { embedding: "$faces.embedding" } },
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
    if ((person.centroid_face_count ?? -1) === count && person.centroid && person.centroid.length === EMBEDDING_DIM) {
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
  const rows = await peopleC
    .find({ merged_into: null } as Filter<PersonDoc>)
    .toArray();
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
  }>([
    { $match: { faces: { $exists: true, $ne: [] } } },
    { $unwind: { path: "$faces", includeArrayIndex: "face_index" } },
    { $match: { "faces.person_id": null } },
    { $match: { "faces.embedding": { $exists: true, $ne: [] } } },
    {
      $project: {
        face_index: 1,
        embedding: "$faces.embedding",
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
    });
  }
  return out;
}

/** Highest "Person N" suffix currently in the DB so brand-new auto-names
 * extend the sequence rather than collide. Returns 0 when no auto-named
 * person exists. */
async function maxAutoNameIndex(): Promise<number> {
  const peopleC = await peopleCollection();
  const cursor = peopleC.find(
    { name: { $regex: /^Person \d+$/ } } as Filter<PersonDoc>,
  );
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
        $or: [
          { cover_asset_id: { $exists: false } },
          { cover_asset_id: null },
        ],
      } as Filter<PersonDoc>,
      { projection: { _id: 1 } },
    )
    .toArray();
  if (missing.length === 0) return;

  const missingHexIds = missing.map((p) => p._id.toHexString());

  // One aggregation produces `(person_hex → best_asset_id)` for every
  // person in `missingHexIds`. $sort + $group/$first picks the highest-
  // confidence face per person; ties break by Mongo's insertion order on
  // the unwound rows, which is deterministic enough for "any reasonable
  // face."
  const cursor = assets.aggregate<{ _id: string; best_asset_id: ObjectId }>([
    { $match: { faces: { $exists: true, $ne: [] } } },
    { $unwind: "$faces" },
    { $match: { "faces.person_id": { $in: missingHexIds } } },
    {
      $project: {
        _id: 1,
        person_id: "$faces.person_id",
        confidence: "$faces.confidence",
      },
    },
    { $sort: { confidence: -1 } },
    {
      $group: {
        _id: "$person_id",
        best_asset_id: { $first: "$_id" },
      },
    },
  ]);

  const updates: Array<{
    updateOne: {
      filter: Filter<PersonDoc>;
      update: {
        $set: { cover_asset_id: string; updated_at: string };
        $unset: { cover_face_id: "" };
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
            updated_at: now,
          },
          // Drop the legacy field so old + new docs converge on one shape.
          $unset: { cover_face_id: "" },
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

// ---------------------------------------------------------------------------
// Vector helpers
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
