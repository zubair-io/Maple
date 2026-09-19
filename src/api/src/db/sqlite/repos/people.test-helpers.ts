/**
 * Fixtures for the people and faces tests (#3749).
 *
 * Deliberately thin: each helper inserts one row and returns its id, so a test
 * reads as the situation it is describing rather than as a setup script. The
 * embedding generators are here rather than in each test file because two
 * different suites — the clustering parity tests and the pool tests — have to
 * build the *same* vectors to compare results, and a copied generator that
 * drifted by one constant would make them silently incomparable.
 */

import type { Database } from 'bun:sqlite';
import { ObjectId } from '../../object-id.ts';
import type { SqlParams, SqlRow, SqlStatement, SqlWriteResult } from '../protocol.ts';
import type { SqliteDb } from './db-handle.ts';
import { caseFoldKey } from '../case-fold.ts';
import { insertAsset, insertFolder, insertLocation, run } from '../test-sqlite.test-helpers.ts';
import { EMBEDDING_DIM } from '../../../people/cluster-embeddings.ts';

/**
 * A `SqliteDb` over a `bun:sqlite` handle a test owns outright.
 *
 * The pool cannot be used from a test: it spawns worker threads against a file,
 * and a per-test database is normally in-memory. This is the same seam the
 * assets suite uses, promoted to a helper because eight files now want it.
 */
export function testDb(db: Database): SqliteDb {
  const bind = (params: SqlParams | undefined): never[] =>
    (params === undefined ? [] : Array.isArray(params) ? [...params] : [params]) as never[];

  const runOne = (statement: SqlStatement): SqlWriteResult => {
    const result = db.prepare(statement.sql).run(...bind(statement.params));
    return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
  };

  return {
    read<T = SqlRow>(sql: string, params?: SqlParams): Promise<T[]> {
      return Promise.resolve(db.query(sql).all(...bind(params)) as T[]);
    },
    write(sql: string, params?: SqlParams): Promise<SqlWriteResult> {
      return Promise.resolve(runOne({ sql, params }));
    },
    transaction(statements: readonly SqlStatement[]): Promise<SqlWriteResult[]> {
      db.run('BEGIN IMMEDIATE');
      try {
        const results = statements.map(runOne);
        db.run('COMMIT');
        return Promise.resolve(results);
      } catch (error) {
        try {
          db.run('ROLLBACK');
        } catch {
          // Already unwound; the original error is the one worth reporting.
        }
        return Promise.reject(error);
      }
    },
  };
}

export interface PersonFixture {
  id?: string;
  name?: string;
  hidden?: boolean;
  excluded?: boolean;
  mergedInto?: string | null;
  centroid?: number[] | null;
  centroidFaceCount?: number | null;
  coverAssetId?: string | null;
  suggestedMerges?: Array<{ person_id: string; score: number }> | null;
  suggestedMergeHead?: { person_id: string; score: number } | null;
}

/** Inserts one person and returns its id. */
export function insertPerson(db: Database, overrides: PersonFixture = {}): string {
  const id = overrides.id ?? new ObjectId().toHexString();
  const name = overrides.name ?? `Person of ${id.slice(-6)}`;
  const when = new Date().toISOString();
  const head = overrides.suggestedMergeHead ?? null;
  run(
    db,
    `INSERT INTO people
       (id, name, name_key, created_at, updated_at, merged_into, hidden, excluded,
        centroid, centroid_face_count, cover_asset_id,
        suggested_merge_person_id, suggested_merge_score, suggested_merges)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    name,
    caseFoldKey(name),
    when,
    when,
    overrides.mergedInto ?? null,
    overrides.hidden ? 1 : 0,
    overrides.excluded ? 1 : 0,
    overrides.centroid === undefined || overrides.centroid === null
      ? null
      : JSON.stringify(overrides.centroid),
    overrides.centroidFaceCount ?? null,
    overrides.coverAssetId ?? null,
    head?.person_id ?? null,
    head?.score ?? null,
    overrides.suggestedMerges ? JSON.stringify(overrides.suggestedMerges) : null,
  );
  return id;
}

export interface FaceFixture {
  assetId: string;
  faceIndex?: number;
  personId?: string | null;
  confidence?: number;
  hidden?: boolean;
  embedding?: number[] | null;
  bbox?: { x: number; y: number; w: number; h: number };
}

/** Inserts one face row. */
export function insertFace(db: Database, fixture: FaceFixture): void {
  const bbox = fixture.bbox ?? { x: 0, y: 0, w: 1, h: 1 };
  run(
    db,
    `INSERT INTO faces
       (asset_id, face_index, person_id, confidence,
        bbox_x, bbox_y, bbox_w, bbox_h, hidden, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    fixture.assetId,
    fixture.faceIndex ?? 0,
    fixture.personId ?? null,
    fixture.confidence ?? 0.9,
    bbox.x,
    bbox.y,
    bbox.w,
    bbox.h,
    fixture.hidden ? 1 : 0,
    fixture.embedding ? JSON.stringify(fixture.embedding) : null,
  );
}

/** A library root every live asset in a test can hang off. */
export function insertLibrary(db: Database): string {
  return insertFolder(db);
}

/**
 * An asset that satisfies the live predicate: not soft-deleted, and holding one
 * location that is neither deleted nor missing. Liveness matters to almost
 * every query here, so "insert an asset" without it would be a trap.
 */
export function insertLiveAsset(
  db: Database,
  libraryId: string,
  overrides: { id?: string; capturedAt?: string } = {},
): string {
  const exif = overrides.capturedAt ? JSON.stringify({ captured_at: overrides.capturedAt }) : null;
  const id = insertAsset(db, { id: overrides.id, exif });
  insertLocation(db, { assetId: id, libraryId });
  return id;
}

/**
 * A unit vector pointing mostly along `axis`, with `jitter` spread across the
 * next two dimensions. Two vectors on the same axis score high against each
 * other; two on different axes score near zero.
 */
export function nearAxis(axis: number, jitter: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0);
  vector[axis] = 1 - jitter;
  vector[(axis + 1) % EMBEDDING_DIM] = jitter / 2;
  vector[(axis + 2) % EMBEDDING_DIM] = jitter / 2;
  return vector;
}
