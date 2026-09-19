/**
 * Fixtures for the `/api/people/*` route suites, against SQLite (#3787).
 *
 * The route suites used to insert one Mongo document per asset with its faces
 * nested inside it. Faces are their own table now, so "an asset with these
 * faces on it" is three inserts across three tables — the shape below, so that
 * a test still reads as the situation it is describing.
 *
 * `db/sqlite/repos/people.test-helpers.ts` already has `insertPerson`,
 * `insertFace` and `insertLiveAsset`; what it does not have is one call that
 * creates a live asset *and* the faces hanging off it, which is what every
 * route test here starts from. The read-back helpers exist for the same reason:
 * an assertion that used to be `findOne({_id}).faces[0].person_id` is a SELECT,
 * and spelling it once keeps the tests about behaviour rather than about SQL.
 */

import type { Database } from 'bun:sqlite';
import { insertFace, insertLiveAsset } from '../../src/db/sqlite/repos/people.test-helpers.ts';
import type { Bbox } from '../../src/db/schema.ts';

/** One face as a route test describes it. */
export interface FaceSeed {
  bbox?: Bbox;
  personId?: string | null;
  confidence?: number;
  hidden?: boolean;
  embedding?: number[] | null;
}

/**
 * A live asset in `libraryId`, carrying `faces` in the order given.
 *
 * The array index becomes `face_index`, which is how a client addresses a face
 * on the wire — the same positional contract the Mongo array had.
 */
export function insertAssetWithFaces(
  db: Database,
  libraryId: string,
  faces: readonly FaceSeed[],
): string {
  const assetId = insertLiveAsset(db, libraryId);
  for (const [faceIndex, face] of faces.entries()) {
    insertFace(db, {
      assetId,
      faceIndex,
      personId: face.personId ?? null,
      confidence: face.confidence ?? 0.9,
      hidden: face.hidden ?? false,
      embedding: face.embedding ?? null,
      bbox: face.bbox ?? { x: 0, y: 0, w: 1, h: 1 },
    });
  }
  return assetId;
}

/** One face row's mutable state, or null when the face is gone. */
export function faceState(
  db: Database,
  assetId: string,
  faceIndex: number,
): { personId: string | null; hidden: boolean } | null {
  const row = db
    .query(`SELECT person_id, hidden FROM faces WHERE asset_id = ? AND face_index = ?`)
    .get(assetId, faceIndex) as { person_id: string | null; hidden: number } | null;
  return row === null ? null : { personId: row.person_id, hidden: row.hidden === 1 };
}

/** A person's stored cover asset id, or null when nothing has set one. */
export function coverAssetId(db: Database, personId: string): string | null {
  const row = db.query(`SELECT cover_asset_id FROM people WHERE id = ?`).get(personId) as {
    cover_asset_id: string | null;
  } | null;
  return row?.cover_asset_id ?? null;
}

/**
 * Removes the person row while leaving every face still pointing at it.
 *
 * `faces.person_id` is `ON DELETE SET NULL`, so an ordinary delete releases the
 * faces and the dangling pointer cannot be observed afterwards. The dangling
 * state is real all the same — it is what a request sees when a person is
 * deleted or merged between reading a face and writing that person's cover —
 * and suspending the constraint for the one statement is how a test reaches it
 * without having to interleave two requests.
 */
export function deletePersonLeavingFaces(db: Database, personId: string): void {
  db.run('PRAGMA foreign_keys = OFF');
  try {
    db.run(`DELETE FROM people WHERE id = ?`, [personId]);
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}

/**
 * Empties every table these suites write to, in foreign-key order.
 *
 * Only needed by a suite that holds one database for the whole file — which is
 * the clustering route's doing, since the clustering pass reaches the pool by
 * file path and so cannot run against a fresh in-memory database per test.
 */
export function clearPeopleFixtures(db: Database): void {
  db.run('DELETE FROM faces');
  db.run('DELETE FROM asset_locations');
  db.run('DELETE FROM assets');
  db.run('DELETE FROM people');
}
