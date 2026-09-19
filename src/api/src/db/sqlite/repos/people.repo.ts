// The blocks this shares with `people/people.repo.ts` are the ones that do not
// touch a database at all — the same DTO assembled from rows instead of from a
// document. Factoring them into a shared helper would couple the two
// implementations together shortly before one of them is deleted, which is the
// opposite of what this migration's beside-then-switch shape is for. The
// duplication ends when the Mongo module goes (#3785).
// fallow-ignore-file code-duplication

/**
 * People repository — the SQLite port of `people/people.repo.ts` (#3749).
 *
 * Every function the Mongo repo exports has an equivalent here with the same
 * name, the same parameters and the same return type, so the cutover (#3752)
 * changes an import path and nothing else. The one substitution is the optional
 * trailing `dbOverride`, which accepts a SQLite handle instead of a Mongo `Db`.
 *
 * ## Why both repositories exist right now
 *
 * MongoDB is still the live database. Nothing here is wired into a route, and
 * the Mongo repo is untouched and still serving every request. That is staged
 * work tracked by the cutover ticket, in the same shape the pool (#3742), the
 * schema (#3743) and the assets port (#3746) landed in: build the replacement
 * beside the original, prove it, then switch the imports in one commit. There
 * is deliberately no runtime switch and no factory choosing between the two.
 *
 * ## Layout
 *
 *   - `people.sql.ts`               every statement, with the index it uses
 *   - `people.rows.ts`              rows → documents, and the bbox flattening
 *   - `people.repo.ts`              create, rename, list, detail, face writes
 *   - `people.list.ts`              the shared list body and its covers
 *   - `people.face-count.ts`        the derived count that replaces `face_count`
 *   - `people.merge.ts`             merge as one transaction
 *   - `people.merge-suggestions.ts` the banner and the dismiss action
 *   - `people.cover.ts`             choosing a cover face
 *   - `people.visibility.ts`        hide / exclude and their recovery lists
 *   - `people.search-filter.ts`     names ⇄ ids for the search layer
 *   - `people.search-reindex.ts`    re-arming the meili stage
 *   - `people.cluster-load.ts`      the clustering load + compute stage
 *   - `people.clustering-job.ts`    the clustering write side
 *
 * ## What a person lookup costs now
 *
 * A face is a row in `faces`, not an entry in an array on its asset. "Which
 * photos is this person in" was `$match` → `$unwind` → `$match` again — once to
 * find assets holding a matching face, once more after unwinding to discard the
 * other faces on those assets — and is now a join against `faces_person`. The
 * same change is what lets the per-person face count be derived rather than
 * maintained; `people.face-count.ts` has that argument in full.
 */

import { ObjectId } from 'mongodb';
import path from 'node:path';
import { child as childLogger } from '../../../log.ts';
import { assertValidPersonName } from '../../../people/person-name.ts';
import { caseFoldKey } from '../case-fold.ts';
import { newObjectIdHex } from '../object-id.ts';
import type { SqlStatement } from '../protocol.ts';
import { peopleDb, type SqliteDb } from './db-handle.ts';
import {
  LIVE_VISIBLE_PREDICATE,
  listPeopleByFilter,
  type ListPeopleOptions,
  type PersonWithCount,
} from './people.list.ts';
import { mergeInto } from './people.merge.ts';
import { loadSuggestedMergeInfo, type SuggestedMergeInfo } from './people.merge-suggestions.ts';
import { toAssetFace, toPerson, type PersonFaceRow, type PersonRow } from './people.rows.ts';
import {
  markAssetIdsForMeiliReindexBestEffort,
  markAssetsForMeiliReindexBestEffort,
} from './people.search-reindex.ts';
import {
  ASSET_EXISTS_SQL,
  DIRTY_CENTROID_SQL,
  FACES_BY_ASSET_SQL,
  HIDE_FACE_SQL,
  INSERT_PERSON_SQL,
  LIVE_PERSON_BY_NAME_SQL,
  PERSON_BY_ID_SQL,
  PERSON_FACE_PAGE_SQL,
  primaryLocationsSql,
  RENAME_PERSON_SQL,
  SET_FACE_PERSON_SQL,
} from './people.sql.ts';
import type { AssetFaceDoc, Bbox, PersonWithId } from '../../schema.ts';

const log = childLogger('people:repo:sqlite');

export interface RenameResult {
  survivor: PersonWithId;
  mergedFrom?: ObjectId;
}

export interface PersonDetailFace {
  asset_id: string;
  face_index: number;
  abs_path: string;
  bbox: Bbox;
  confidence: number;
}

export interface PersonDetail {
  person: PersonWithId;
  faces: PersonDetailFace[];
  suggestedMerge: SuggestedMergeInfo | null;
}

export const FACE_DETAIL_LIMIT = 50;
const FACE_DETAIL_MAX = 200;

export type { SqliteDb } from './db-handle.ts';
export type { ListPeopleOptions, PersonWithCount } from './people.list.ts';
export type { SuggestedMergeInfo } from './people.merge-suggestions.ts';

// The visibility toggles and id lists live in `people.visibility.ts`, and are
// re-exported here so importers match the Mongo repo's surface exactly.

function nowIso(): string {
  return new Date().toISOString();
}

/** One person by id, or null. */
async function findById(db: SqliteDb, hex: string): Promise<PersonWithId | null> {
  const rows = await db.read<PersonRow>(PERSON_BY_ID_SQL, [hex]);
  const row = rows[0];
  return row ? toPerson(row) : null;
}

/** The live person holding this name, compared case-insensitively. */
async function findByNameCI(db: SqliteDb, name: string): Promise<PersonWithId | null> {
  const rows = await db.read<PersonRow>(LIVE_PERSON_BY_NAME_SQL, [caseFoldKey(name)]);
  const row = rows[0];
  return row ? toPerson(row) : null;
}

/**
 * True when two names are the same name — the rule the unique index enforces.
 *
 * Folded through `caseFoldKey` rather than compared with `localeCompare`, so
 * this and the database cannot disagree about whether a rename is a collision.
 */
function sameNameCI(a: string, b: string): boolean {
  return caseFoldKey(a) === caseFoldKey(b);
}

/**
 * Create a person, or return the one that already holds this name.
 *
 * Idempotent for the operator's "type a name" flow, and the unique index is the
 * safety net underneath: a concurrent caller that inserts the same name between
 * the lookup and the insert makes this one's insert fail, and the recovery is
 * to re-read and return the winner rather than to surface a constraint error
 * for something that is not an error.
 */
export async function createPerson(name: string, dbOverride?: SqliteDb): Promise<PersonWithId> {
  const trimmed = assertValidPersonName(name);
  const db = peopleDb(dbOverride);
  const existing = await findByNameCI(db, trimmed);
  if (existing) return existing;

  const id = newObjectIdHex();
  const created = nowIso();
  try {
    await db.write(INSERT_PERSON_SQL, [id, trimmed, caseFoldKey(trimmed), created, created]);
  } catch (err) {
    const raced = await findByNameCI(db, trimmed);
    if (raced) return raced;
    throw err;
  }
  log.info({ id, name: trimmed }, 'created person');
  // Built from what was inserted rather than by reading a row back through
  // `toPerson`. The difference is visible on the wire: `toPerson` emits the
  // suggestion head as an explicit null, because a clustered row always carries
  // one, and `JSON.stringify` keeps an explicit null while dropping an absent
  // key. The Mongo `createPerson` builds a document with four fields and no
  // suggestion fields at all, so `POST /api/people` answers without them, and a
  // client testing for presence rather than value would see the change.
  return {
    _id: new ObjectId(id),
    name: trimmed,
    created_at: created,
    updated_at: created,
    merged_into: null,
  } as PersonWithId;
}

/** Rename in place and re-index. The shared tail of the three non-merge branches. */
async function applyRename(
  db: SqliteDb,
  subject: PersonWithId,
  trimmed: string,
  dbOverride?: SqliteDb,
): Promise<RenameResult> {
  await db.write(RENAME_PERSON_SQL, [
    trimmed,
    caseFoldKey(trimmed),
    nowIso(),
    subject._id.toHexString(),
  ]);
  // A case-only rename still changes the indexed token ("alice" → "Alice"), so
  // it re-indexes too.
  markAssetsForMeiliReindexBestEffort([subject._id], dbOverride);
  return { survivor: { ...subject, name: trimmed } };
}

/**
 * Rename a person, merging when the new name is already taken.
 *
 * Naming two clusters the same thing is how an operator says they are the same
 * person, so a collision is not an error: the two rows merge and the caller
 * learns which one was absorbed through `mergedFrom`.
 *
 * The survivor is the lexicographically smaller id — the older one, since
 * ObjectIds lead with a timestamp. Choosing by id rather than by which side the
 * operator happened to rename makes the outcome the same either way round.
 */
export async function renamePerson(
  id: ObjectId,
  name: string,
  dbOverride?: SqliteDb,
): Promise<RenameResult> {
  const trimmed = assertValidPersonName(name);
  const db = peopleDb(dbOverride);
  const hex = id.toHexString();
  const subject = await findById(db, hex);
  if (!subject) throw new Error(`person not found: ${hex}`);
  if (subject.merged_into) throw new Error(`person already merged: ${hex}`);

  if (sameNameCI(subject.name, trimmed)) {
    if (subject.name === trimmed) return { survivor: subject };
    return applyRename(db, subject, trimmed, dbOverride);
  }

  const collision = await findByNameCI(db, trimmed);
  // No collision, or the only match is this row itself.
  if (!collision || collision._id.equals(id)) {
    return applyRename(db, subject, trimmed, dbOverride);
  }

  const survivorIsSubject = subject._id.toString() < collision._id.toString();
  const survivor = survivorIsSubject ? subject : collision;
  const orphan = survivorIsSubject ? collision : subject;
  await mergeInto(survivor._id, orphan._id, trimmed, dbOverride);
  // Both sides need re-indexing: the orphan's faces moved to the survivor, and
  // the survivor's display name may have changed.
  markAssetsForMeiliReindexBestEffort([survivor._id, orphan._id], dbOverride);

  const fresh = await findById(db, survivor._id.toHexString());
  if (!fresh) throw new Error('survivor disappeared mid-merge');
  return { survivor: fresh, mergedFrom: orphan._id };
}

/**
 * Every live, visible person, name-sorted.
 *
 * Hidden and excluded people are filtered at the person level only. The
 * clustering seed queries stay unfiltered on purpose, so a hidden person keeps
 * absorbing their newly detected faces instead of spawning a fresh visible
 * cluster — see `people.cluster-load.ts`.
 */
export function listPeople(
  options: ListPeopleOptions = {},
  dbOverride?: SqliteDb,
): Promise<PersonWithCount[]> {
  return listPeopleByFilter(LIVE_VISIBLE_PREDICATE, options, dbOverride);
}

interface FacePageRow {
  asset_id: string;
  face_index: number;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  confidence: number;
}

interface LocationRow {
  asset_id: string;
  path: string;
  filename: string;
  root: string;
  slug: string;
}

/**
 * One person plus a page of their faces, most recently captured first.
 *
 * Returns null for an unknown person and for one that has been merged away —
 * the route turns both into a 404, because a merged person's page would show
 * somebody else's photos under a name that no longer exists.
 *
 * A face whose asset cannot be resolved to a file is dropped. On Mongo that
 * filter runs in JavaScript after the page has been cut, so a page can come
 * back short; here the join does the same thing for the same reason, and the
 * liveness predicate is part of the query rather than a stage that has to be
 * ordered ahead of the sort by hand (#2103).
 */
export async function getPerson(
  id: ObjectId,
  faceOffset: number = 0,
  faceLimit: number = FACE_DETAIL_LIMIT,
  dbOverride?: SqliteDb,
): Promise<PersonDetail | null> {
  const clampedLimit = Math.min(Math.max(1, faceLimit), FACE_DETAIL_MAX);
  const clampedOffset = Math.max(0, faceOffset);
  const db = peopleDb(dbOverride);
  const person = await findById(db, id.toHexString());
  if (!person || person.merged_into) return null;

  const page = await db.read<FacePageRow>(PERSON_FACE_PAGE_SQL, [
    id.toHexString(),
    clampedLimit,
    clampedOffset,
  ]);
  const assetIds = [...new Set(page.map((row) => row.asset_id))];
  const [locations, suggestedMerge] = await Promise.all([
    assetIds.length === 0
      ? Promise.resolve([] as LocationRow[])
      : db.read<LocationRow>(primaryLocationsSql(assetIds.length), assetIds),
    loadSuggestedMergeInfo(db, person),
  ]);
  const byAsset = new Map(locations.map((row) => [row.asset_id, row] as const));

  const faces = page.flatMap((row) => {
    const location = byAsset.get(row.asset_id);
    if (!location || !location.root) return [];
    const segments = location.path === '' ? [] : location.path.split('/');
    return [
      {
        asset_id: row.asset_id,
        face_index: row.face_index,
        abs_path: path.join(location.root, ...segments, location.filename),
        bbox: { x: row.bbox_x, y: row.bbox_y, w: row.bbox_w, h: row.bbox_h },
        confidence: row.confidence,
      },
    ];
  });

  return { person, faces, suggestedMerge };
}

/** The face at `(assetId, faceIndex)`, with the not-found errors both writers share. */
async function readFaceForWrite(
  db: SqliteDb,
  assetId: ObjectId,
  faceIndex: number,
): Promise<PersonFaceRow> {
  if (!Number.isInteger(faceIndex) || faceIndex < 0) {
    throw new Error(`invalid face index: ${faceIndex}`);
  }
  const assetHex = assetId.toHexString();
  const [assets, faces] = await Promise.all([
    db.read<{ id: string }>(ASSET_EXISTS_SQL, [assetHex]),
    db.read<PersonFaceRow>(FACES_BY_ASSET_SQL, [assetHex]),
  ]);
  if (assets.length === 0) throw new Error(`asset not found: ${assetHex}`);
  const face = faces.find((row) => row.face_index === faceIndex);
  if (!face) {
    throw new Error(`face index out of range: ${faceIndex} (asset has ${faces.length} faces)`);
  }
  return face;
}

/** Mark a person's stored centroid stale. `-1` is the force-recompute tag. */
function dirtyCentroid(hex: string, when: string): SqlStatement {
  return { sql: DIRTY_CENTROID_SQL, params: [when, hex] };
}

/**
 * Point one face at a person, or at nobody.
 *
 * An idempotent reassignment to the person the face already belongs to writes
 * nothing further: no centroid is dirtied and no re-index is queued, because
 * nothing downstream changed.
 *
 * No face count is adjusted, here or anywhere. The count is derived from these
 * very rows, so moving the row *is* the update — see `people.face-count.ts`.
 */
export async function assignFaceToPerson(
  assetId: ObjectId,
  faceIndex: number,
  personId: ObjectId | null,
  dbOverride?: SqliteDb,
): Promise<void> {
  const db = peopleDb(dbOverride);
  const face = await readFaceForWrite(db, assetId, faceIndex);
  const personHex = personId ? personId.toHexString() : null;
  const priorHex = face.person_id;

  if (priorHex === personHex) {
    await db.write(SET_FACE_PERSON_SQL, [personHex, assetId.toHexString(), faceIndex]);
    return;
  }

  const when = nowIso();
  // Both people's stored centroids are now stale: one lost a face, one gained
  // it. Written in the same transaction as the assignment so a reader can never
  // see the face moved while a centroid still claims it.
  const dirty = [
    ...(priorHex === null ? [] : [dirtyCentroid(priorHex, when)]),
    ...(personHex === null ? [] : [dirtyCentroid(personHex, when)]),
  ];
  await db.transaction([
    { sql: SET_FACE_PERSON_SQL, params: [personHex, assetId.toHexString(), faceIndex] },
    ...dirty,
  ]);
  markAssetIdsForMeiliReindexBestEffort([assetId], dbOverride);
}

/**
 * Hide a face — the operator's "this is not something I want tracked".
 *
 * Writes `hidden` and clears `person_id` in one statement, so the row is never
 * momentarily a hidden face that still points at a person: such a row shows up
 * nowhere in the UI while still inflating that person's centroid on the next
 * recompute. Idempotent.
 */
export async function hideFace(
  assetId: ObjectId,
  faceIndex: number,
  dbOverride?: SqliteDb,
): Promise<void> {
  const db = peopleDb(dbOverride);
  const face = await readFaceForWrite(db, assetId, faceIndex);
  const priorHex = face.person_id;
  const statements: SqlStatement[] = [
    { sql: HIDE_FACE_SQL, params: [assetId.toHexString(), faceIndex] },
    ...(priorHex === null ? [] : [dirtyCentroid(priorHex, nowIso())]),
  ];
  await db.transaction(statements);
  if (priorHex !== null) markAssetIdsForMeiliReindexBestEffort([assetId], dbOverride);
}

/**
 * Every face on one asset, in the array order the wire still uses.
 *
 * `face_index` survives the migration because clients address a face by it —
 * the person detail page projects it and the "Move to…" action sends it back.
 */
export async function readFaces(assetId: ObjectId, dbOverride?: SqliteDb): Promise<AssetFaceDoc[]> {
  const db = peopleDb(dbOverride);
  const rows = await db.read<PersonFaceRow>(FACES_BY_ASSET_SQL, [assetId.toHexString()]);
  return rows.map(toAssetFace);
}
