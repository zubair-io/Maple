/**
 * Merging two people into one (#3749).
 *
 * A merge is a repoint plus a tombstone: every face assigned to the orphan is
 * reassigned to the survivor, and the orphan keeps a `merged_into` pointer for
 * the audit trail. That pointer doubles as the soft-delete marker — a row that
 * has one is excluded from every listing — so nothing is destroyed and a
 * mistaken merge stays diagnosable.
 *
 * ## The merge is atomic here, and was not before
 *
 * The Mongo version issues five independent writes, and a process that dies
 * between the first and the second leaves the faces repointed at a survivor
 * while the orphan is still a live, listable person holding a duplicate name.
 * All four writes below go through `transaction`, so the merge either happens
 * or does not. That is a behaviour improvement rather than a port artefact, and
 * it is available only because the single writer worker makes `BEGIN IMMEDIATE`
 * free of contention.
 *
 * ## No face counts are touched
 *
 * The Mongo version zeroes the orphan's `face_count` and recomputes the
 * survivor's from ground truth, because repointing the faces does not move a
 * stored number with them. There is no stored number here: both people's counts
 * are a `COUNT(*)` over `faces`, and repointing the rows *is* the update. See
 * `people.face-count.ts`.
 */

import type { ObjectId } from 'mongodb';
import { caseFoldKey } from '../case-fold.ts';
import type { SqlStatement } from '../protocol.ts';
import { peopleDb, type SqliteDb } from './db-handle.ts';
import { toPerson, type PersonRow } from './people.rows.ts';
import { markAssetsForMeiliReindexBestEffort } from './people.search-reindex.ts';
import {
  CLAIM_SURVIVOR_SQL,
  CLEAR_SUGGESTIONS_POINTING_AT_SQL,
  MARK_MERGED_SQL,
  peopleByIdsSql,
  PERSON_BY_ID_SQL,
  REPOINT_FACES_SQL,
} from './people.sql.ts';
import type { PersonWithId } from '../../schema.ts';

export interface MergePeopleResult {
  survivor: PersonWithId;
  mergedCount: number;
}

/** One person by id, or null. */
async function readPerson(db: SqliteDb, hex: string): Promise<PersonWithId | null> {
  const rows = await db.read<PersonRow>(PERSON_BY_ID_SQL, [hex]);
  const row = rows[0];
  return row ? toPerson(row) : null;
}

/**
 * The four statements one merge is made of, in the order they must run.
 *
 * Extracted so `mergePeopleInto` can concatenate several merges into a single
 * transaction rather than opening one per source.
 */
function mergeStatements(survivorHex: string, orphanHex: string, name: string): SqlStatement[] {
  const now = new Date().toISOString();
  return [
    // Every one of the orphan's faces now belongs to the survivor.
    { sql: REPOINT_FACES_SQL, params: [survivorHex, orphanHex] },
    // The orphan becomes a tombstone and stops suggesting anything.
    { sql: MARK_MERGED_SQL, params: [survivorHex, now, orphanHex] },
    // Nobody else may keep pointing a suggestion at a person that no longer
    // exists as a merge target.
    { sql: CLEAR_SUGGESTIONS_POINTING_AT_SQL, params: [orphanHex] },
    // The survivor takes the name and is marked for a centroid recompute: it
    // just absorbed faces, so its stored mean is stale by construction.
    { sql: CLAIM_SURVIVOR_SQL, params: [name, caseFoldKey(name), now, survivorHex] },
  ];
}

/**
 * Repoint `orphan`'s faces onto `survivor`, tombstone the orphan, and give the
 * survivor `name`.
 *
 * The single primitive both merge paths share — the rename collision in
 * `people.repo.ts` and the explicit multi-select merge below.
 */
export async function mergeInto(
  survivor: ObjectId,
  orphan: ObjectId,
  name: string,
  dbOverride?: SqliteDb,
): Promise<void> {
  const db = peopleDb(dbOverride);
  await db.transaction(mergeStatements(survivor.toHexString(), orphan.toHexString(), name));
}

/**
 * Merge several people into `targetId`, which always survives — it keeps its
 * id, its name, its cover and its creation timestamp.
 *
 * Sources that are the target itself, already merged, unknown, or repeated in
 * the list are skipped rather than failing the call: the operator selected a
 * set in a grid that may have moved under them, and merging the rest is the
 * useful answer. Only a bad *target* throws.
 */
export async function mergePeopleInto(
  targetId: ObjectId,
  sourceIds: ObjectId[],
  dbOverride?: SqliteDb,
): Promise<MergePeopleResult> {
  const db = peopleDb(dbOverride);
  const targetHex = targetId.toHexString();
  const target = await readPerson(db, targetHex);
  if (!target) throw new Error(`person not found: ${targetHex}`);
  if (target.merged_into) throw new Error(`person already merged: ${targetHex}`);

  const candidateHexes = [...new Set(sourceIds.map((id) => id.toHexString()))].filter(
    (hex) => hex !== targetHex,
  );
  const sources =
    candidateHexes.length === 0
      ? []
      : await db.read<PersonRow>(peopleByIdsSql(candidateHexes.length), candidateHexes);
  const mergeable = sources.filter((row) => row.merged_into === null);

  if (mergeable.length > 0) {
    await db.transaction(
      mergeable.flatMap((row) => mergeStatements(targetHex, row.id, target.name)),
    );
  }

  const survivor = await readPerson(db, targetHex);
  if (!survivor) throw new Error('target disappeared mid-merge');

  if (mergeable.length > 0) {
    // The survivor's name now applies to every absorbed person's photos, so the
    // search documents of all of them are stale.
    markAssetsForMeiliReindexBestEffort([targetId, ...sourceIds], dbOverride);
  }
  return { survivor, mergedCount: mergeable.length };
}
