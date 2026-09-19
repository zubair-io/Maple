/**
 * The people repository's read and write verbs (#3749).
 *
 * The error strings are asserted verbatim, not by shape. The web client shows
 * several of them to the operator, so a reworded message is a user-visible
 * change and should fail here rather than be noticed in a screenshot.
 *
 * Naming — create, rename, and the search layer's name lookups — is in
 * `people.names.test.ts`, because "two people cannot hold the same name, so
 * naming one after another merges them" is a rule in its own right rather than
 * a property of any single verb.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import {
  createTestDatabase,
  insertAsset,
  insertLocation,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { assignFaceToPerson, getPerson, hideFace, listPeople, readFaces } from './people.repo.ts';
import { listExcludedPeople, listHiddenPeople, personIdsToDrop } from './people.visibility.ts';
import { hidePerson, excludePerson, unhidePerson } from './people.visibility.ts';
import { setPersonCover } from './people.cover.ts';
import {
  insertFace,
  insertLibrary,
  insertLiveAsset,
  insertPerson,
  testDb,
} from './people.test-helpers.ts';

describe('listPeople', () => {
  test('is name-sorted case-insensitively and hides the marked and the merged', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const survivor = insertPerson(db, { name: 'zeta' });
    insertPerson(db, { name: 'Ada' });
    insertPerson(db, { name: 'bob' });
    insertPerson(db, { name: 'Hidden', hidden: true });
    insertPerson(db, { name: 'Excluded', excluded: true });
    insertPerson(db, { name: 'Merged', mergedInto: survivor });

    const listed = await listPeople({}, testDb(db));

    // A byte-order sort would put every capitalised name ahead of every
    // lowercase one, which is not what the Mongo collation does.
    expect(listed.map((row) => row.person.name)).toEqual(['Ada', 'bob', 'zeta']);
  });

  test('resolves each cover asset to a path and a public address', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertFolderAt(handle, '/library', 'lib');
    const asset = insertAsset(db);
    insertLocation(db, { assetId: asset, libraryId: library, path: 'trips', filename: 'a.dng' });
    insertPerson(db, { name: 'Ada', coverAssetId: asset });

    const listed = await listPeople({}, testDb(db));

    expect(listed[0]?.coverAbsPath).toBe('/library/trips/a.dng');
    expect(listed[0]?.coverAddress).toBe('lib:trips/a.dng');
  });

  test('prefers a live location over a dead one at a lower ordinal', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertFolderAt(handle, '/library', 'lib');
    const asset = insertAsset(db);
    insertLocation(db, {
      assetId: asset,
      libraryId: library,
      ordinal: 0,
      filename: 'gone.dng',
      deletedAt: '2025-01-01T00:00:00Z',
    });
    insertLocation(db, { assetId: asset, libraryId: library, ordinal: 1, filename: 'here.dng' });
    insertPerson(db, { name: 'Ada', coverAssetId: asset });

    const listed = await listPeople({}, testDb(db));

    expect(listed[0]?.coverAddress).toBe('lib:vacation/2024/here.dng');
  });

  test('a cover whose every file is gone resolves to no cover at all', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertFolderAt(handle, '/library', 'lib');
    const asset = insertAsset(db);
    insertLocation(db, {
      assetId: asset,
      libraryId: library,
      filename: 'deleted.dng',
      deletedAt: '2025-01-01T00:00:00Z',
    });
    insertLocation(db, {
      assetId: asset,
      libraryId: library,
      ordinal: 1,
      filename: 'missing.dng',
      missingSince: '2025-02-01T00:00:00Z',
    });
    insertPerson(db, { name: 'Ada', coverAssetId: asset });

    const listed = await listPeople({}, testDb(db));

    // Mongo's assetPrimaryFileInfo answers null unless some entry is live, and
    // the grid turns that into the no-cover placeholder. Falling back to the
    // lowest-ordinal dead entry hands it a path that 404s instead.
    expect(listed[0]?.person.name).toBe('Ada');
    expect(listed[0]?.coverAbsPath).toBeNull();
    expect(listed[0]?.coverAddress).toBeNull();
  });
});

/** A library root with a known path and slug, for the address assertions. */
function insertFolderAt(
  handle: Awaited<ReturnType<typeof createTestDatabase>>,
  path: string,
  slug: string,
): string {
  const id = new ObjectId().toHexString();
  handle.db.run(
    `INSERT INTO folders (id, path, slug, label, file_count, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
    [id, path, slug, 'Library', new Date().toISOString()],
  );
  return id;
}

describe('getPerson', () => {
  test('returns the person with a page of faces, newest capture first', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const older = insertLiveAsset(db, library, { capturedAt: '2024-01-01T00:00:00Z' });
    const newer = insertLiveAsset(db, library, { capturedAt: '2025-01-01T00:00:00Z' });
    insertFace(db, { assetId: older, personId: ada, confidence: 0.7 });
    insertFace(db, { assetId: newer, personId: ada, confidence: 0.8 });

    const detail = await getPerson(new ObjectId(ada), 0, 50, testDb(db));

    expect(detail?.faces.map((face) => face.asset_id)).toEqual([newer, older]);
    expect(detail?.faces[0]?.confidence).toBe(0.8);
    expect(detail?.faces[0]?.abs_path).toContain(newer);
  });

  test('pages through the faces and clamps the limit', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const assets = ['2025-03-01', '2025-02-01', '2025-01-01'].map((day) =>
      insertLiveAsset(db, library, { capturedAt: `${day}T00:00:00Z` }),
    );
    for (const asset of assets) insertFace(db, { assetId: asset, personId: ada });
    const dbHandle = testDb(db);

    const firstPage = await getPerson(new ObjectId(ada), 0, 2, dbHandle);
    const secondPage = await getPerson(new ObjectId(ada), 2, 2, dbHandle);
    // A limit of zero is clamped up to one rather than returning nothing.
    const clamped = await getPerson(new ObjectId(ada), 0, 0, dbHandle);

    expect(firstPage?.faces.map((face) => face.asset_id)).toEqual([assets[0]!, assets[1]!]);
    expect(secondPage?.faces.map((face) => face.asset_id)).toEqual([assets[2]!]);
    expect(clamped?.faces).toHaveLength(1);
  });

  test('pages two faces of one asset without repeating or skipping either', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    // Both faces are on the same asset, so they tie on captured_at and on id —
    // every sort key the page had before face_index was added to it.
    const asset = insertLiveAsset(db, library, { capturedAt: '2025-01-01T00:00:00Z' });
    insertFace(db, { assetId: asset, faceIndex: 0, personId: ada });
    insertFace(db, { assetId: asset, faceIndex: 1, personId: ada });
    const dbHandle = testDb(db);

    const first = await getPerson(new ObjectId(ada), 0, 1, dbHandle);
    const second = await getPerson(new ObjectId(ada), 1, 1, dbHandle);

    expect(first?.faces.map((face) => face.face_index)).toEqual([0]);
    expect(second?.faces.map((face) => face.face_index)).toEqual([1]);
  });

  test('drops faces whose asset no longer resolves to a file', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const live = insertLiveAsset(db, library);
    insertFace(db, { assetId: live, personId: ada });
    // Trashed: excluded by the live predicate.
    const trashed = insertAsset(db, { deletedAt: new Date().toISOString() });
    insertLocation(db, { assetId: trashed, libraryId: library });
    insertFace(db, { assetId: trashed, personId: ada });
    // Hidden face on a live asset.
    const hidden = insertLiveAsset(db, library);
    insertFace(db, { assetId: hidden, personId: ada, hidden: true });

    const detail = await getPerson(new ObjectId(ada), 0, 50, testDb(db));

    expect(detail?.faces.map((face) => face.asset_id)).toEqual([live]);
  });

  test('a page window landing on unresolvable faces still returns the resolvable ones (#2103)', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const withFace = (capturedAt: string, present: boolean): void => {
      const asset = insertAsset(db, { exif: JSON.stringify({ captured_at: capturedAt }) });
      insertLocation(db, {
        assetId: asset,
        libraryId: library,
        missingSince: present ? null : new Date().toISOString(),
      });
      insertFace(db, { assetId: asset, personId: ada });
    };
    // The three most recent faces are on files that have gone missing; the two
    // older ones still resolve.
    withFace('2026-07-19T10:00:00Z', false);
    withFace('2026-07-19T09:00:00Z', false);
    withFace('2026-07-19T08:00:00Z', false);
    withFace('2026-05-01T10:00:00Z', true);
    withFace('2026-05-01T09:00:00Z', true);

    const detail = await getPerson(new ObjectId(ada), 0, 3, testDb(db));

    // Filtering unresolvable faces *after* the limit — which is what the Mongo
    // aggregation did before #2103 — makes this page come back empty while
    // thousands of resolvable faces sit on later pages.
    expect(detail?.faces).toHaveLength(2);
  });

  test('answers null for an unknown person and for a merged one', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const survivor = insertPerson(db, { name: 'Survivor' });
    const merged = insertPerson(db, { name: 'Gone', mergedInto: survivor });
    const dbHandle = testDb(db);

    expect(await getPerson(new ObjectId(), 0, 50, dbHandle)).toBeNull();
    // A merged person's page would show somebody else's photos under a name
    // that no longer exists.
    expect(await getPerson(new ObjectId(merged), 0, 50, dbHandle)).toBeNull();
  });
});

describe('assignFaceToPerson', () => {
  test('points a face at a person and dirties both centroids', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada', centroidFaceCount: 4 });
    const grace = insertPerson(db, { name: 'Grace', centroidFaceCount: 9 });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, personId: ada });

    await assignFaceToPerson(new ObjectId(asset), 0, new ObjectId(grace), testDb(db));

    const face = db.query('SELECT person_id FROM faces WHERE asset_id = ?').get(asset);
    expect(face).toEqual({ person_id: grace });
    // Both stored means are now wrong, so both are tagged for recompute.
    const counts = db
      .query('SELECT id, centroid_face_count AS n FROM people ORDER BY name')
      .all() as Array<{ id: string; n: number }>;
    expect(counts.every((row) => row.n === -1)).toBe(true);
  });

  test('unassigns when given null', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, personId: ada });

    await assignFaceToPerson(new ObjectId(asset), 0, null, testDb(db));

    expect(db.query('SELECT person_id FROM faces WHERE asset_id = ?').get(asset)).toEqual({
      person_id: null,
    });
  });

  test('reassigning to the same person leaves the centroid alone', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada', centroidFaceCount: 4 });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, personId: ada });

    await assignFaceToPerson(new ObjectId(asset), 0, new ObjectId(ada), testDb(db));

    // Nothing downstream changed, so nothing downstream is invalidated.
    expect(db.query('SELECT centroid_face_count AS n FROM people WHERE id = ?').get(ada)).toEqual({
      n: 4,
    });
  });

  test('refuses a bad index, an unknown asset, or an index past the end', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, faceIndex: 0 });
    const dbHandle = testDb(db);
    const missing = new ObjectId();

    await expect(assignFaceToPerson(new ObjectId(asset), -1, null, dbHandle)).rejects.toThrow(
      'invalid face index: -1',
    );
    await expect(assignFaceToPerson(missing, 0, null, dbHandle)).rejects.toThrow(
      `asset not found: ${missing.toHexString()}`,
    );
    await expect(assignFaceToPerson(new ObjectId(asset), 3, null, dbHandle)).rejects.toThrow(
      'face index out of range: 3 (asset has 1 faces)',
    );
  });
});

describe('hideFace', () => {
  test('hides the face and drops its person in one write', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada', centroidFaceCount: 3 });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, personId: ada });

    await hideFace(new ObjectId(asset), 0, testDb(db));

    // A hidden face still pointing at a person shows up nowhere in the UI while
    // still inflating that person's centroid, so the two move together.
    expect(db.query('SELECT hidden, person_id FROM faces WHERE asset_id = ?').get(asset)).toEqual({
      hidden: 1,
      person_id: null,
    });
    expect(db.query('SELECT centroid_face_count AS n FROM people WHERE id = ?').get(ada)).toEqual({
      n: -1,
    });
  });

  test('is idempotent', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, hidden: true });
    const dbHandle = testDb(db);

    await hideFace(new ObjectId(asset), 0, dbHandle);
    await hideFace(new ObjectId(asset), 0, dbHandle);

    expect(db.query('SELECT hidden FROM faces WHERE asset_id = ?').get(asset)).toEqual({
      hidden: 1,
    });
  });
});

describe('readFaces', () => {
  test('returns the faces in array order, omitting the fields that were absent', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, faceIndex: 1, confidence: 0.5 });
    insertFace(db, {
      assetId: asset,
      faceIndex: 0,
      confidence: 0.9,
      embedding: [1, 2, 3],
      hidden: true,
    });

    const faces = await readFaces(new ObjectId(asset), testDb(db));

    expect(faces).toHaveLength(2);
    expect(faces[0]).toEqual({
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      person_id: null,
      confidence: 0.9,
      embedding: [1, 2, 3],
      hidden: true,
    });
    // An absent optional stays absent rather than becoming an explicit null: a
    // client that tests for the key would otherwise see a behaviour change.
    expect(Object.keys(faces[1]!)).toEqual(['bbox', 'person_id', 'confidence']);
  });

  test('an asset with no faces answers an empty array', async () => {
    using handle = await createTestDatabase();

    expect(await readFaces(new ObjectId(), testDb(handle.db))).toEqual([]);
  });
});

describe('visibility', () => {
  test('hide and exclude move a person between the three listings', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const ada = insertPerson(db, { name: 'Ada' });
    const dbHandle = testDb(db);

    await hidePerson(new ObjectId(ada), dbHandle);
    const hidden = await listHiddenPeople({}, dbHandle);
    await excludePerson(new ObjectId(ada), dbHandle);
    const excluded = await listExcludedPeople({}, dbHandle);
    const stillHidden = await listHiddenPeople({}, dbHandle);

    expect(hidden.map((row) => row.person.name)).toEqual(['Ada']);
    // Excluded is the stronger marker, so a person in both states is listed
    // once, on the stronger page.
    expect(excluded.map((row) => row.person.name)).toEqual(['Ada']);
    expect(stillHidden).toEqual([]);
  });

  test('unhide returns the person to the main listing', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const ada = insertPerson(db, { name: 'Ada', hidden: true });
    const dbHandle = testDb(db);

    await unhidePerson(new ObjectId(ada), dbHandle);

    expect((await listPeople({}, dbHandle)).map((row) => row.person.name)).toEqual(['Ada']);
  });

  test('personIdsToDrop always drops the excluded and opts in to the hidden', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const hidden = insertPerson(db, { name: 'Hidden', hidden: true });
    const excluded = insertPerson(db, { name: 'Excluded', excluded: true });
    insertPerson(db, { name: 'Visible' });
    const dbHandle = testDb(db);

    const withoutOptIn = await personIdsToDrop(undefined, dbHandle);
    const withOptIn = await personIdsToDrop('true', dbHandle);

    expect(withoutOptIn).toEqual([excluded]);
    expect(withOptIn.sort()).toEqual([excluded, hidden].sort());
  });
});

describe('setPersonCover', () => {
  test('takes the bbox from the face rather than from the caller', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const asset = insertLiveAsset(db, library);
    insertFace(db, {
      assetId: asset,
      personId: ada,
      bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    });

    const result = await setPersonCover(new ObjectId(ada), new ObjectId(asset), 0, testDb(db));

    expect(result).toEqual({ ok: true });
    expect(
      db
        .query(
          'SELECT cover_asset_id, cover_bbox_x AS x, cover_bbox_h AS h FROM people WHERE id = ?',
        )
        .get(ada),
    ).toEqual({ cover_asset_id: asset, x: 0.1, h: 0.4 });
  });

  test('reports each refusal with its status rather than throwing', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const other = insertPerson(db, { name: 'Grace' });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, faceIndex: 0, personId: other });
    insertFace(db, { assetId: asset, faceIndex: 1, personId: ada, hidden: true });
    const dbHandle = testDb(db);
    const missing = new ObjectId();

    expect(await setPersonCover(new ObjectId(ada), new ObjectId(asset), -1, dbHandle)).toEqual({
      error: 'invalid face index: -1',
      status: 400,
    });
    expect(await setPersonCover(new ObjectId(ada), missing, 0, dbHandle)).toEqual({
      error: `asset not found: ${missing.toHexString()}`,
      status: 404,
    });
    expect(await setPersonCover(new ObjectId(ada), new ObjectId(asset), 5, dbHandle)).toEqual({
      error: 'face index out of range: 5 (asset has 2 faces)',
      status: 400,
    });
    expect(await setPersonCover(new ObjectId(ada), new ObjectId(asset), 0, dbHandle)).toEqual({
      error: 'face does not belong to this person',
      status: 400,
    });
    expect(await setPersonCover(new ObjectId(ada), new ObjectId(asset), 1, dbHandle)).toEqual({
      error: 'face is hidden',
      status: 400,
    });
  });
});
