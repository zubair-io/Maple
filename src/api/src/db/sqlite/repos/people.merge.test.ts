/**
 * Merging people, and the merge-suggestion banner that proposes it (#3749).
 *
 * Both halves of the ticket's "merge and dismissal behaviour": what a merge does
 * to the rows, and what a dismissal does to the suggestion that prompted it.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../../object-id.ts';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import { mergeInto, mergePeopleInto } from './people.merge.ts';
import {
  dismissMergeSuggestion,
  loadMergeDismissals,
  loadSuggestedMergeInfo,
} from './people.merge-suggestions.ts';
import { toPerson, type PersonRow } from './people.rows.ts';
import { PERSON_BY_ID_SQL } from './people.sql.ts';
import { sortedPairKey } from '../../../people/people-merge-suggestions.ts';
import {
  insertFace,
  insertLibrary,
  insertLiveAsset,
  insertPerson,
  testDb,
} from './people.test-helpers.ts';
import type { SqliteDb } from './db-handle.ts';

async function readPerson(db: SqliteDb, hex: string) {
  const rows = await db.read<PersonRow>(PERSON_BY_ID_SQL, [hex]);
  return rows[0] ? toPerson(rows[0]) : null;
}

describe('mergeInto', () => {
  test('repoints the faces, tombstones the orphan and names the survivor', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const survivor = insertPerson(db, { name: 'Ada', centroidFaceCount: 7 });
    const orphan = insertPerson(db, {
      name: 'Ada L',
      suggestedMergeHead: { person_id: survivor, score: 0.9 },
    });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, personId: orphan });

    await mergeInto(new ObjectId(survivor), new ObjectId(orphan), 'Ada Lovelace', testDb(db));

    expect(db.query('SELECT person_id FROM faces WHERE asset_id = ?').get(asset)).toEqual({
      person_id: survivor,
    });
    expect(
      db
        .query('SELECT merged_into, suggested_merge_person_id AS head FROM people WHERE id = ?')
        .get(orphan),
    ).toEqual({ merged_into: survivor, head: null });
    expect(
      db.query('SELECT name, centroid_face_count AS n FROM people WHERE id = ?').get(survivor),
    ).toEqual({ name: 'Ada Lovelace', n: -1 });
  });

  test('clears every third party still pointing a suggestion at the orphan', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const survivor = insertPerson(db, { name: 'Ada' });
    const orphan = insertPerson(db, { name: 'Ada L' });
    const bystander = insertPerson(db, {
      name: 'Grace',
      suggestedMergeHead: { person_id: orphan, score: 0.8 },
    });

    await mergeInto(new ObjectId(survivor), new ObjectId(orphan), 'Ada', testDb(db));

    // Nobody may keep suggesting a merge into a row that is now a tombstone.
    expect(
      db
        .query(
          'SELECT suggested_merge_person_id AS head, suggested_merge_score AS score FROM people WHERE id = ?',
        )
        .get(bystander),
    ).toEqual({ head: null, score: null });
  });

  test('is atomic — a failing statement leaves nothing behind', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const survivor = insertPerson(db, { name: 'Ada' });
    const orphan = insertPerson(db, { name: 'Ada L' });
    const blocker = insertPerson(db, { name: 'Taken' });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, personId: orphan });

    // Renaming the survivor onto a name another live person already holds
    // violates the unique index, and it is the last of the four statements —
    // so the face repoint has already happened when it fails.
    await expect(
      mergeInto(new ObjectId(survivor), new ObjectId(orphan), 'Taken', testDb(db)),
    ).rejects.toThrow();

    expect(db.query('SELECT person_id FROM faces WHERE asset_id = ?').get(asset)).toEqual({
      person_id: orphan,
    });
    expect(db.query('SELECT merged_into FROM people WHERE id = ?').get(orphan)).toEqual({
      merged_into: null,
    });
    expect(db.query('SELECT name FROM people WHERE id = ?').get(blocker)).toEqual({
      name: 'Taken',
    });
  });
});

describe('mergePeopleInto', () => {
  test('the target survives and keeps its name', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const target = insertPerson(db, { name: 'Ada' });
    const first = insertPerson(db, { name: 'A. Lovelace' });
    const second = insertPerson(db, { name: 'Countess' });
    for (const person of [first, second]) {
      insertFace(db, { assetId: insertLiveAsset(db, library), personId: person });
    }

    const result = await mergePeopleInto(
      new ObjectId(target),
      [new ObjectId(first), new ObjectId(second)],
      testDb(db),
    );

    expect(result.mergedCount).toBe(2);
    expect(result.survivor.name).toBe('Ada');
    expect(result.survivor._id.toHexString()).toBe(target);
    const moved = db.query('SELECT COUNT(*) AS n FROM faces WHERE person_id = ?').get(target) as {
      n: number;
    };
    expect(moved.n).toBe(2);
  });

  test('skips the target itself, duplicates, unknowns and the already merged', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const target = insertPerson(db, { name: 'Ada' });
    const real = insertPerson(db, { name: 'Real' });
    const elsewhere = insertPerson(db, { name: 'Elsewhere' });
    const alreadyMerged = insertPerson(db, { name: 'Gone', mergedInto: elsewhere });

    const result = await mergePeopleInto(
      new ObjectId(target),
      [
        new ObjectId(target),
        new ObjectId(real),
        new ObjectId(real),
        new ObjectId(alreadyMerged),
        new ObjectId(),
      ],
      testDb(db),
    );

    // The operator selected a set in a grid that may have moved under them;
    // merging the rest is the useful answer, so only a bad target throws.
    expect(result.mergedCount).toBe(1);
  });

  test('refuses an unknown or already-merged target', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const survivor = insertPerson(db, { name: 'Survivor' });
    const merged = insertPerson(db, { name: 'Gone', mergedInto: survivor });
    const dbHandle = testDb(db);
    const missing = new ObjectId();

    await expect(mergePeopleInto(missing, [], dbHandle)).rejects.toThrow(
      `person not found: ${missing.toHexString()}`,
    );
    await expect(mergePeopleInto(new ObjectId(merged), [], dbHandle)).rejects.toThrow(
      `person already merged: ${merged}`,
    );
  });
});

describe('loadSuggestedMergeInfo', () => {
  test('returns the best still-valid candidate with its cover', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const asset = insertLiveAsset(db, library);
    const best = insertPerson(db, { name: 'Best', coverAssetId: asset });
    db.run(
      'UPDATE people SET cover_bbox_x = 0.1, cover_bbox_y = 0.2, cover_bbox_w = 0.3, cover_bbox_h = 0.4 WHERE id = ?',
      [best],
    );
    const subject = insertPerson(db, {
      name: 'Subject',
      suggestedMerges: [{ person_id: best, score: 0.88 }],
    });
    const dbHandle = testDb(db);

    const info = await loadSuggestedMergeInfo(dbHandle, (await readPerson(dbHandle, subject))!);

    expect(info?.name).toBe('Best');
    expect(info?.score).toBe(0.88);
    expect(info?.coverAssetId).toBe(asset);
    expect(info?.coverBbox).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  test('walks past candidates that have since been merged, hidden or excluded', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const survivor = insertPerson(db, { name: 'Survivor' });
    const gone = insertPerson(db, { name: 'Gone', mergedInto: survivor });
    const hidden = insertPerson(db, { name: 'Hidden', hidden: true });
    const excluded = insertPerson(db, { name: 'Excluded', excluded: true });
    const valid = insertPerson(db, { name: 'Valid' });
    const subject = insertPerson(db, {
      name: 'Subject',
      suggestedMerges: [
        { person_id: gone, score: 0.95 },
        { person_id: hidden, score: 0.9 },
        { person_id: excluded, score: 0.85 },
        { person_id: valid, score: 0.8 },
      ],
    });
    const dbHandle = testDb(db);

    const info = await loadSuggestedMergeInfo(dbHandle, (await readPerson(dbHandle, subject))!);

    // This is what lets the banner advance the instant a candidate stops being
    // offerable, rather than going blank until the next clustering pass.
    expect(info?.name).toBe('Valid');
  });

  test('falls back to the denormalised head on a row written before the ranked list', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const other = insertPerson(db, { name: 'Other' });
    const legacy = insertPerson(db, {
      name: 'Legacy',
      suggestedMergeHead: { person_id: other, score: 0.7 },
    });
    const dbHandle = testDb(db);

    const info = await loadSuggestedMergeInfo(dbHandle, (await readPerson(dbHandle, legacy))!);

    expect(info?.name).toBe('Other');
    expect(info?.score).toBe(0.7);
  });
});

describe('dismissMergeSuggestion', () => {
  test('records the pair and advances this person to the next candidate', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const first = insertPerson(db, { name: 'First' });
    const second = insertPerson(db, { name: 'Second' });
    const subject = insertPerson(db, {
      name: 'Subject',
      suggestedMergeHead: { person_id: first, score: 0.9 },
      suggestedMerges: [
        { person_id: first, score: 0.9 },
        { person_id: second, score: 0.8 },
      ],
    });
    const dbHandle = testDb(db);

    const result = await dismissMergeSuggestion(
      new ObjectId(subject),
      new ObjectId(first),
      dbHandle,
    );
    const dismissed = await loadMergeDismissals(dbHandle);

    expect(result).toBe('dismissed');
    expect(dismissed.has(sortedPairKey(subject, first))).toBe(true);
    expect(
      db
        .query(
          'SELECT suggested_merge_person_id AS head, suggested_merge_score AS score FROM people WHERE id = ?',
        )
        .get(subject),
    ).toEqual({ head: second, score: 0.8 });
  });

  test('clears the head when the dismissed pair was the last candidate', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const only = insertPerson(db, { name: 'Only' });
    const subject = insertPerson(db, {
      name: 'Subject',
      suggestedMergeHead: { person_id: only, score: 0.9 },
      suggestedMerges: [{ person_id: only, score: 0.9 }],
    });

    await dismissMergeSuggestion(new ObjectId(subject), new ObjectId(only), testDb(db));

    expect(
      db.query('SELECT suggested_merge_person_id AS head FROM people WHERE id = ?').get(subject),
    ).toEqual({ head: null });
  });

  test('advances the other side only when it points back', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const unrelated = insertPerson(db, { name: 'Unrelated' });
    const subject = insertPerson(db, { name: 'Subject' });
    const pointingBack = insertPerson(db, {
      name: 'Pointing back',
      suggestedMergeHead: { person_id: subject, score: 0.9 },
      suggestedMerges: [{ person_id: subject, score: 0.9 }],
    });
    const holdingOther = insertPerson(db, {
      name: 'Holding other',
      suggestedMergeHead: { person_id: unrelated, score: 0.7 },
      suggestedMerges: [{ person_id: unrelated, score: 0.7 }],
    });
    db.run(
      'UPDATE people SET suggested_merge_person_id = ?, suggested_merge_score = 0.9, suggested_merges = ? WHERE id = ?',
      [
        pointingBack,
        JSON.stringify([
          { person_id: pointingBack, score: 0.9 },
          { person_id: holdingOther, score: 0.75 },
        ]),
        subject,
      ],
    );
    const dbHandle = testDb(db);

    await dismissMergeSuggestion(new ObjectId(subject), new ObjectId(pointingBack), dbHandle);

    // The reciprocal suggestion is stale too, so it clears.
    expect(
      db
        .query('SELECT suggested_merge_person_id AS head FROM people WHERE id = ?')
        .get(pointingBack),
    ).toEqual({ head: null });
    // An unrelated suggestion somebody else holds is none of this dismissal's
    // business and must survive untouched.
    expect(
      db
        .query('SELECT suggested_merge_person_id AS head FROM people WHERE id = ?')
        .get(holdingOther),
    ).toEqual({ head: unrelated });
  });

  test('answers stale, without writing, when the pair is no longer suggested', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const stranger = insertPerson(db, { name: 'Stranger' });
    const subject = insertPerson(db, { name: 'Subject' });
    const dbHandle = testDb(db);

    const unknownPerson = await dismissMergeSuggestion(
      new ObjectId(),
      new ObjectId(stranger),
      dbHandle,
    );
    const notACandidate = await dismissMergeSuggestion(
      new ObjectId(subject),
      new ObjectId(stranger),
      dbHandle,
    );

    // The route turns 'stale' into a 404: the suggestion changed server-side
    // between the page render and the click.
    expect(unknownPerson).toBe('stale');
    expect(notACandidate).toBe('stale');
    expect((await loadMergeDismissals(dbHandle)).size).toBe(0);
  });

  test('a repeat dismissal is accepted rather than colliding', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const other = insertPerson(db, { name: 'Other' });
    const subject = insertPerson(db, {
      name: 'Subject',
      suggestedMergeHead: { person_id: other, score: 0.9 },
      suggestedMerges: [{ person_id: other, score: 0.9 }],
    });
    const dbHandle = testDb(db);

    await dismissMergeSuggestion(new ObjectId(subject), new ObjectId(other), dbHandle);
    // The head is cleared now, but the ranked list still names the pair, so the
    // route can be hit twice — by a double click, or a stale second tab.
    const second = await dismissMergeSuggestion(
      new ObjectId(subject),
      new ObjectId(other),
      dbHandle,
    );

    expect(second).toBe('dismissed');
    expect((await loadMergeDismissals(dbHandle)).size).toBe(1);
  });

  test('a dismissed candidate stays out of the banner', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const first = insertPerson(db, { name: 'First' });
    const second = insertPerson(db, { name: 'Second' });
    const subject = insertPerson(db, {
      name: 'Subject',
      suggestedMergeHead: { person_id: first, score: 0.9 },
      suggestedMerges: [
        { person_id: first, score: 0.9 },
        { person_id: second, score: 0.8 },
      ],
    });
    const dbHandle = testDb(db);

    await dismissMergeSuggestion(new ObjectId(subject), new ObjectId(first), dbHandle);
    const info = await loadSuggestedMergeInfo(dbHandle, (await readPerson(dbHandle, subject))!);

    expect(info?.name).toBe('Second');
  });
});
