/**
 * Online face clustering, write side (#3749) — the port of
 * `people/clustering-job.ts`.
 *
 * For every face nobody has claimed, find the nearest existing person by cosine
 * similarity and assign it to them, or open a new auto-named "Person N" when no
 * existing cluster is close enough. Idempotent: a second run over unchanged
 * data assigns nothing, because every face already has a person.
 *
 * The comparison itself lives in `people.cluster-load.ts` and runs on the
 * clustering worker. This module owns only the cheap, write-shaped half —
 * materialising new people, applying assignments, persisting centroids and
 * merge suggestions, and backfilling covers.
 *
 * ## One thing this no longer does
 *
 * The Mongo version ends every pass by recounting every person's faces and
 * rewriting the denormalised `face_count`, with a comment explaining that the
 * pass is the one place that walks all assignments and therefore doubles as the
 * authoritative self-heal for drift introduced between passes. There is no
 * counter to heal here: the count is derived from the `faces` rows this pass
 * has just written. That whole step is gone rather than ported, and
 * `people.face-count.ts` is where the reasoning lives.
 */

import { ObjectId } from 'mongodb';
import { child as childLogger } from '../../../log.ts';
import { DEFAULT_SIMILARITY_THRESHOLD } from '../../../people/cluster-embeddings.ts';
import { sortedPairKey, type MergeSuggestion } from '../../../people/people-merge-suggestions.ts';
import { newObjectIdHex } from '../object-id.ts';
import type { SqlStatement } from '../protocol.ts';
import { peopleDb, type SqliteDb } from './db-handle.ts';
import { prepareClusteringPassOffThread } from './people.cluster-pool.ts';
import type { PreparedClusteringPass } from './people.cluster-load.ts';
import { loadMergeDismissals, suggestionStatement } from './people.merge-suggestions.ts';
import { suggestedMergesJson } from './people.rows.ts';
import { markAssetIdsForMeiliReindexBestEffort } from './people.search-reindex.ts';
import {
  bestCoverFacesSql,
  INSERT_CLUSTER_PERSON_SQL,
  PEOPLE_MISSING_COVER_SQL,
  SET_CENTROID_SQL,
  SET_COVER_SQL,
  SET_FACE_PERSON_SQL,
} from './people.sql.ts';

const log = childLogger('people:clustering:sqlite');

export interface RunOnlineClusteringOptions {
  /** Cosine threshold to merge a face into an existing cluster. Default 0.5. */
  similarityThreshold?: number;
}

export interface RunOnlineClusteringResult {
  /** Faces newly assigned during this run, brand-new clusters included. */
  assigned: number;
  /** New "Person N" rows created during this run. */
  newPeople: number;
  /** Faces examined. */
  scanned: number;
}

/**
 * How many statements go into one transaction.
 *
 * A first pass over a large library assigns tens of thousands of faces, and
 * sending them as a single message would mean holding the whole batch in memory
 * on both sides of the boundary and taking the write lock for its entire
 * duration. Chunking bounds both. The chunks are not individually meaningful —
 * a pass that dies half-way leaves some faces assigned and the rest to be
 * picked up by the next run, which is exactly what the Mongo version's
 * successive `bulkWrite` calls do.
 */
const WRITE_CHUNK = 1000;

/** Apply statements in bounded transactions, in order. */
async function writeChunked(db: SqliteDb, statements: readonly SqlStatement[]): Promise<void> {
  for (let start = 0; start < statements.length; start += WRITE_CHUNK) {
    await db.transaction(statements.slice(start, start + WRITE_CHUNK));
  }
}

/** The person each face ends up with, and the rows any new people need. */
interface Materialised {
  assignments: Array<{ assetId: string; faceIndex: number; personHex: string }>;
  inserts: SqlStatement[];
  newPeople: number;
}

/**
 * Turn cluster ids into person ids, minting a row for each new cluster.
 *
 * A cluster id below `seedCount` names a person that already exists; anything
 * above it is a cluster this pass opened, and the first face to land in one
 * decides both the new person's id and its cover crop. Later faces in the same
 * cluster reuse that id rather than creating a second row.
 */
function materialise(pass: PreparedClusteringPass, when: string): Materialised {
  const newPersonIds = new Map<number, string>();
  const inserts: SqlStatement[] = [];
  let nextAutoIndex = pass.maxAutoIndex;

  const assignments = pass.faces.map((face, index) => {
    const cluster = pass.assignments[index]!;
    if (cluster < pass.seedCount) {
      return {
        assetId: face.asset_id_hex,
        faceIndex: face.face_index,
        personHex: pass.seedPersonIds[cluster]!,
      };
    }
    const cached = newPersonIds.get(cluster);
    if (cached !== undefined) {
      return { assetId: face.asset_id_hex, faceIndex: face.face_index, personHex: cached };
    }
    const personHex = newObjectIdHex();
    newPersonIds.set(cluster, personHex);
    nextAutoIndex += 1;
    inserts.push({
      sql: INSERT_CLUSTER_PERSON_SQL,
      params: [
        personHex,
        `Person ${nextAutoIndex}`,
        when,
        when,
        JSON.stringify(pass.clusters[cluster]!.centroid),
        pass.clusters[cluster]!.face_count,
        face.asset_id_hex,
        face.bbox.x,
        face.bbox.y,
        face.bbox.w,
        face.bbox.h,
      ],
    });
    return { assetId: face.asset_id_hex, faceIndex: face.face_index, personHex };
  });

  return { assignments, inserts, newPeople: inserts.length };
}

/**
 * Persist the refreshed centroid of every pre-existing cluster that took on new
 * faces this pass.
 *
 * New clusters are skipped: their insert already carried the final centroid and
 * count, so writing them again would be a second statement saying the same
 * thing.
 */
function centroidStatements(pass: PreparedClusteringPass): SqlStatement[] {
  const touched = [...new Set(pass.assignments)].filter((cluster) => cluster < pass.seedCount);
  return touched.map((cluster) => ({
    sql: SET_CENTROID_SQL,
    params: [
      JSON.stringify(pass.clusters[cluster]!.centroid),
      pass.clusters[cluster]!.face_count,
      pass.seedPersonIds[cluster]!,
    ],
  }));
}

/**
 * Write this pass's merge suggestions across every live person it considered —
 * not only the ones with a qualifying match.
 *
 * Anyone absent from `suggestions` is explicitly cleared, so a suggestion that
 * has gone stale (dismissed, or the match since hidden, merged, or no longer
 * the best) heals on the very next run instead of lingering until something
 * happens to overwrite it.
 *
 * The dismissal set is re-read here rather than reused from the compute
 * snapshot. A dismissal that landed while the pass was in flight would
 * otherwise be overwritten by the pass's stale view, resurrecting a suggestion
 * the operator has already answered — and the next run only comes when new
 * faces arrive, so it could sit there for a long time.
 */
async function persistMergeSuggestions(
  db: SqliteDb,
  seedPersonIds: readonly string[],
  suggestions: readonly MergeSuggestion[],
): Promise<void> {
  if (seedPersonIds.length === 0) return;
  const dismissed = await loadMergeDismissals(db);
  const byPerson = new Map(
    suggestions
      .map((suggestion) => ({
        personIdHex: suggestion.personIdHex,
        candidates: suggestion.candidates
          .filter(
            (candidate) =>
              !dismissed.has(sortedPairKey(suggestion.personIdHex, candidate.suggestedPersonIdHex)),
          )
          .map((candidate) => ({ hex: candidate.suggestedPersonIdHex, score: candidate.score })),
      }))
      .filter((suggestion) => suggestion.candidates.length > 0)
      .map((suggestion) => [suggestion.personIdHex, suggestion.candidates] as const),
  );

  await writeChunked(
    db,
    seedPersonIds.map((personHex) => {
      const candidates = byPerson.get(personHex) ?? [];
      const head = candidates[0];
      return suggestionStatement(
        personHex,
        head?.hex ?? null,
        head?.score ?? null,
        suggestedMergesJson(candidates),
      );
    }),
  );
}

/**
 * Walk every unassigned face and give it a person.
 *
 * Idempotent: a second run over unchanged data finds nothing unassigned and
 * writes nothing.
 */
export async function runOnlineClustering(
  options: RunOnlineClusteringOptions = {},
  dbOverride?: SqliteDb,
): Promise<RunOnlineClusteringResult> {
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const db = peopleDb(dbOverride);

  // The whole load and compute stage runs off this thread. Only assignments,
  // updated centroids and per-face envelopes come back — never an embedding.
  const { pass } = await prepareClusteringPassOffThread(threshold, dbOverride);
  const when = new Date().toISOString();
  const { assignments, inserts, newPeople } = materialise(pass, when);

  // People first: a face may not point at a row that does not exist yet, and
  // the foreign key would say so.
  await writeChunked(db, inserts);
  await writeChunked(
    db,
    assignments.map((assignment) => ({
      sql: SET_FACE_PERSON_SQL,
      params: [assignment.personHex, assignment.assetId, assignment.faceIndex],
    })),
  );
  await writeChunked(db, centroidStatements(pass));
  await persistMergeSuggestions(db, pass.seedPersonIds, pass.mergeSuggestions);

  // Heal any live person still without a cover — rows created before cover
  // seeding existed, or created by hand through `POST /api/people` ahead of any
  // face assignment.
  await backfillCoverAssets(dbOverride);

  // Re-index exactly the assets whose people changed. Re-indexing every asset
  // of every touched person would re-queue huge numbers of unchanged rows on a
  // large library.
  const changedAssets = [...new Set(assignments.map((assignment) => assignment.assetId))];
  if (changedAssets.length > 0) {
    markAssetIdsForMeiliReindexBestEffort(
      changedAssets.map((hex) => new ObjectId(hex)),
      dbOverride,
    );
  }

  log.info(
    { assigned: assignments.length, newPeople, scanned: pass.faces.length, threshold },
    'online clustering finished',
  );
  return { assigned: assignments.length, newPeople, scanned: pass.faces.length };
}

/**
 * Give every live person without a cover their highest-confidence unhidden
 * face. Idempotent, and its fast path is one query returning no rows.
 *
 * Single-flighted: a burst of `/api/people` requests against a library that has
 * never been clustered would otherwise fan out into identical concurrent
 * backfills writing the same rows.
 */
let backfillInFlight: Promise<void> | null = null;

export function backfillCoverAssets(dbOverride?: SqliteDb): Promise<void> {
  if (backfillInFlight) return backfillInFlight;
  backfillInFlight = doBackfillCoverAssets(dbOverride).finally(() => {
    backfillInFlight = null;
  });
  return backfillInFlight;
}

interface CoverFaceRow {
  person_id: string;
  asset_id: string;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
}

async function doBackfillCoverAssets(dbOverride?: SqliteDb): Promise<void> {
  const db = peopleDb(dbOverride);
  const missing = await db.read<{ id: string }>(PEOPLE_MISSING_COVER_SQL);
  if (missing.length === 0) return;

  const ids = missing.map((row) => row.id);
  const covers: CoverFaceRow[] = [];
  for (let start = 0; start < ids.length; start += WRITE_CHUNK) {
    const slice = ids.slice(start, start + WRITE_CHUNK);
    covers.push(...(await db.read<CoverFaceRow>(bestCoverFacesSql(slice.length), slice)));
  }
  if (covers.length === 0) return;

  const when = new Date().toISOString();
  await writeChunked(
    db,
    covers.map((cover) => ({
      sql: SET_COVER_SQL,
      params: [
        cover.asset_id,
        cover.bbox_x,
        cover.bbox_y,
        cover.bbox_w,
        cover.bbox_h,
        when,
        cover.person_id,
      ],
    })),
  );
}

/** Kept for the test suite, mirroring the Mongo module's escape hatch. */
export const _internals = { materialise, centroidStatements, persistMergeSuggestions };
