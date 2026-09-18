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
  EMBEDDING_DIM,
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

/**
 * Converted from the Mongo `people/cluster-load.recompute-heal.test.ts`.
 *
 * A person with a positive `centroid_face_count` but an empty or short stored
 * vector is a stuck state, and it is stuck because it is invisible from both
 * sides: the recompute reads the positive count as "already clean" and skips
 * the row, while the seed load skips it as an unusable vector. So the centroid
 * never rebuilds and any stale merge suggestion the person carries never
 * clears. Treating a positive count with an undecodable vector as dirty is what
 * breaks the deadlock.
 */
describe('the recompute heals a centroid that cannot rebuild itself (#2105)', () => {
  /** A unit vector on one axis, so the mean's argmax is predictable. */
  function axisEmbedding(axis: number): number[] {
    const vector = new Array<number>(EMBEDDING_DIM).fill(0);
    vector[axis] = 1;
    return vector;
  }

  /** One person's stored centroid and count. */
  function storedCentroid(
    db: Database,
    personId: string,
  ): { centroid: string | null; centroid_face_count: number | null } {
    return db
      .query('SELECT centroid, centroid_face_count FROM people WHERE id = ?')
      .get(personId) as { centroid: string | null; centroid_face_count: number | null };
  }

  test('rebuilds the vector when the count is positive but the vector is empty', async () => {
    using dbHandle = await createTestDatabase();
    const db = dbHandle.db;
    const library = insertLibrary(db);
    // The anomalous state: a count nothing could have produced, and no vector.
    const person = insertPerson(db, { name: 'Stuck', centroid: [], centroidFaceCount: 4548 });
    for (let index = 0; index < 2; index += 1) {
      insertFace(db, {
        assetId: insertLiveAsset(db, library),
        personId: person,
        embedding: axisEmbedding(7),
      });
    }

    const updated = await recomputeCentroids(testDb(db));

    expect(updated).toBe(1);
    const row = storedCentroid(db, person);
    const centroid = JSON.parse(row.centroid ?? 'null') as number[];
    expect(centroid).toHaveLength(EMBEDDING_DIM);
    expect(row.centroid_face_count).toBe(2);
    // Both faces sit on axis 7, so the rebuilt mean must too.
    expect(centroid.indexOf(Math.max(...centroid))).toBe(7);
  });

  test('clears to the empty state when the count is positive but no embeddings remain', async () => {
    using dbHandle = await createTestDatabase();
    const db = dbHandle.db;
    const library = insertLibrary(db);
    const person = insertPerson(db, {
      name: 'StuckNoEmbeddings',
      centroid: [],
      centroidFaceCount: 4548,
    });
    // Assigned, but with nothing to average.
    insertFace(db, { assetId: insertLiveAsset(db, library), personId: person, embedding: null });

    await recomputeCentroids(testDb(db));

    expect(storedCentroid(db, person)).toEqual({ centroid: '[]', centroid_face_count: 0 });
  });

  test('leaves the valid cleared state alone', async () => {
    using dbHandle = await createTestDatabase();
    const db = dbHandle.db;
    // An empty vector with a zero count is the legitimate "nobody assigned"
    // state. Rebuilding it would keep every manually created person dirty
    // forever, at a cost that scales with the library.
    const person = insertPerson(db, { name: 'EmptyValid', centroid: [], centroidFaceCount: 0 });

    const updated = await recomputeCentroids(testDb(db));

    expect(updated).toBe(0);
    expect(storedCentroid(db, person)).toEqual({ centroid: '[]', centroid_face_count: 0 });
  });
});
