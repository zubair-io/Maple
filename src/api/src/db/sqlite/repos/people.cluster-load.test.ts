/**
 * What the clustering load stage holds in memory while it runs (#3749).
 *
 * The Mongo original streams both of its inputs through cursors. `db.read`
 * hands back an array, so a literal port materialises the whole result — and
 * the results here are embeddings: 512 floats of JSON text, about 5 KB a row.
 * On a first pass over a large library that is hundreds of megabytes of
 * transient strings on a worker thread, which the review of #3767 flagged.
 *
 * The output is not what these assert — the parity suite next door already
 * pins that against MongoDB, bit for bit, and it is the test that must stay
 * green through any change here. These assert the *shape of the reads*: how
 * many rows one read may return, and how many reads may be in flight at once.
 * Both are invisible to a result comparison and both are the whole fix.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import type { SqlParams, SqlRow } from '../protocol.ts';
import type { SqliteDb } from './db-handle.ts';
import {
  loadUnassignedFaces,
  recomputeCentroids,
  UNASSIGNED_FACE_PAGE,
} from './people.cluster-load.ts';
import {
  insertFace,
  insertLibrary,
  insertLiveAsset,
  insertPerson,
  nearAxis,
  testDb,
} from './people.test-helpers.ts';

interface ReadLog {
  /** Rows returned by each `read`, in the order the reads completed. */
  rowCounts: number[];
  /** The most reads that were ever in flight together. */
  peakConcurrency: number;
}

/** A handle that records the shape of every read passing through it. */
function recordingDb(db: Database): { handle: SqliteDb; log: ReadLog } {
  const inner = testDb(db);
  const log: ReadLog = { rowCounts: [], peakConcurrency: 0 };
  let inFlight = 0;
  const handle: SqliteDb = {
    async read<T = SqlRow>(sql: string, params?: SqlParams): Promise<T[]> {
      inFlight += 1;
      log.peakConcurrency = Math.max(log.peakConcurrency, inFlight);
      try {
        const rows = await inner.read<T>(sql, params);
        log.rowCounts.push(rows.length);
        return rows;
      } finally {
        inFlight -= 1;
      }
    },
    write: (sql, params) => inner.write(sql, params),
    transaction: (statements) => inner.transaction(statements),
  };
  return { handle, log };
}

describe('the unassigned faces are read a page at a time', () => {
  test('a library larger than one page still loads every face, in order', async () => {
    using dbHandle = await createTestDatabase();
    const db = dbHandle.db;
    const library = insertLibrary(db);
    // Three faces past a page boundary, so the cursor has to carry a partial
    // asset across a page as well as land on one.
    const total = UNASSIGNED_FACE_PAGE + 3;
    const seed = db.transaction(() => {
      for (let index = 0; index < total; index += 1) {
        // Two faces per asset, so the tie-break half of the cursor is exercised.
        const faceIndex = index % 2;
        const asset =
          faceIndex === 0
            ? insertLiveAsset(db, library)
            : (db.query('SELECT id FROM assets ORDER BY id DESC LIMIT 1').get() as { id: string })
                .id;
        insertFace(db, {
          assetId: asset,
          faceIndex,
          personId: null,
          embedding: nearAxis(index % 64, 0.05),
        });
      }
    });
    seed();
    const { handle, log } = recordingDb(db);

    const faces = await loadUnassignedFaces(handle);

    const expected = db
      .query(
        `SELECT asset_id, face_index FROM faces
          WHERE person_id IS NULL ORDER BY asset_id, face_index`,
      )
      .all() as Array<{ asset_id: string; face_index: number }>;
    expect(faces).toHaveLength(total);
    // Order is the contract: a face competes against every cluster the faces
    // before it opened, so paging must not reshuffle anything.
    expect(faces.map((face) => `${face.asset_id_hex}:${face.face_index}`)).toEqual(
      expected.map((row) => `${row.asset_id}:${row.face_index}`),
    );
    // And no read ever held more than a page of 5 KB JSON strings.
    expect(log.rowCounts.length).toBeGreaterThan(1);
    expect(Math.max(...log.rowCounts)).toBeLessThanOrEqual(UNASSIGNED_FACE_PAGE);
  });

  test('an exactly-full page is followed by an empty one rather than stopping short', async () => {
    using dbHandle = await createTestDatabase();
    const db = dbHandle.db;
    const library = insertLibrary(db);
    const seed = db.transaction(() => {
      for (let index = 0; index < UNASSIGNED_FACE_PAGE; index += 1) {
        insertFace(db, {
          assetId: insertLiveAsset(db, library),
          personId: null,
          embedding: nearAxis(index % 64, 0.05),
        });
      }
    });
    seed();
    const { handle, log } = recordingDb(db);

    const faces = await loadUnassignedFaces(handle);

    expect(faces).toHaveLength(UNASSIGNED_FACE_PAGE);
    expect(log.rowCounts).toEqual([UNASSIGNED_FACE_PAGE, 0]);
  });
});

describe('the centroid recompute reads one chunk at a time', () => {
  test('more dirty people than one chunk holds never overlaps two reads', async () => {
    using dbHandle = await createTestDatabase();
    const db = dbHandle.db;
    const library = insertLibrary(db);
    // Past the 500-id chunk, so there is a second read to overlap with.
    const seed = db.transaction(() => {
      for (let index = 0; index < 501; index += 1) {
        // -1 is the force-recompute tag, so every one of these is dirty.
        const person = insertPerson(db, { name: `P${index}`, centroidFaceCount: -1 });
        insertFace(db, {
          assetId: insertLiveAsset(db, library),
          personId: person,
          embedding: nearAxis(index % 64, 0.05),
        });
      }
    });
    seed();
    const { handle, log } = recordingDb(db);

    const updated = await recomputeCentroids(handle);

    expect(updated).toBe(501);
    // Reading the chunks concurrently and flattening holds every dirty
    // person's embeddings at once, which on a first pass is all of them.
    expect(log.peakConcurrency).toBe(1);
    expect(log.rowCounts.length).toBeGreaterThan(2);
  });
});
