/**
 * The sub-threshold face purge, at the repository level.
 *
 * The property worth pinning is that the audit and the delete describe the
 * same population: the route prints the audit's numbers and then deletes, so a
 * disagreement between the two is an operator told one thing and given
 * another. Every case below asserts both halves against the same fixture.
 *
 * Two shapes get their own case because they are where a rewrite would go
 * wrong. "Below threshold" is an OR over the two sides of the box, so a face
 * that is narrow but tall counts; and a hidden face that also carries a person
 * id is reported as hidden rather than as assigned, because being hidden is
 * why it survives.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase, insertFolder, testSqliteDb } from '../test-sqlite.test-helpers.ts';
import { insertFaceRow, insertPersonRow } from './assets.test-helpers.ts';
import { auditSubthresholdFaces, purgeSubthresholdFaces } from './faces.purge.ts';
import { seedSearchAsset } from './search.test-helpers.ts';
import type { SqliteDb } from './db-handle.ts';

const THRESHOLD = 0.1;

/** One face to seed. */
interface SeedFace {
  w: number;
  h: number;
  personId?: string | null;
  hidden?: boolean;
}

/** A database holding one asset with these faces, plus one named person. */
async function withFaces<T>(
  faces: (personId: string) => SeedFace[],
  body: (db: SqliteDb, raw: Database, assetId: string, personId: string) => Promise<T>,
): Promise<T> {
  using handle = await createTestDatabase();
  const libraryId = insertFolder(handle.db, { slug: 'purge' });
  const personId = insertPersonRow(handle.db, 'Assigned');
  const assetId = seedSearchAsset(handle.db, libraryId, { capturedAt: null });
  faces(personId).forEach((face, index) => {
    insertFaceRow(handle.db, {
      assetId,
      faceIndex: index,
      personId: face.personId ?? null,
      hidden: face.hidden === true,
      bbox: { x: 0, y: 0, w: face.w, h: face.h },
    });
  });
  return await body(testSqliteDb(handle.db), handle.db, assetId, personId);
}

/** The `face_index` of every surviving face, in order. */
function survivors(raw: Database, assetId: string): number[] {
  return (
    raw
      .query(`SELECT face_index FROM faces WHERE asset_id = ? ORDER BY face_index`)
      .all(assetId) as Array<{ face_index: number }>
  ).map((row) => row.face_index);
}

describe('auditSubthresholdFaces', () => {
  test('sorts sub-threshold faces into unassigned, assigned and hidden', async () => {
    await withFaces(
      (personId) => [
        { w: 0.05, h: 0.05 },
        { w: 0.05, h: 0.05, personId },
        { w: 0.05, h: 0.05, hidden: true },
        { w: 0.3, h: 0.3 },
      ],
      async (db) => {
        const audit = await auditSubthresholdFaces(THRESHOLD, db);
        expect(audit.unassigned).toBe(1);
        expect(audit.assigned).toBe(1);
        expect(audit.hidden).toBe(1);
        expect(audit.assetsScanned).toBe(1);
        expect(audit.assetsAffected).toBe(1);
      },
    );
  });

  test('a face below on either side alone is below threshold', async () => {
    await withFaces(
      () => [
        { w: 0.05, h: 0.4 },
        { w: 0.4, h: 0.05 },
        { w: 0.4, h: 0.4 },
      ],
      async (db) => {
        const audit = await auditSubthresholdFaces(THRESHOLD, db);
        expect(audit.unassigned).toBe(2);
      },
    );
  });

  test('a hidden face carrying a person id is reported as hidden, not as assigned', async () => {
    await withFaces(
      (personId) => [{ w: 0.05, h: 0.05, personId, hidden: true }],
      async (db) => {
        const audit = await auditSubthresholdFaces(THRESHOLD, db);
        expect(audit.hidden).toBe(1);
        expect(audit.assigned).toBe(0);
        // It is not a loss for that person either — nothing removes it.
        expect(audit.personLoss.size).toBe(0);
      },
    );
  });

  test('reports per-person losses for the assigned faces a purge could take', async () => {
    await withFaces(
      (personId) => [
        { w: 0.05, h: 0.05, personId },
        { w: 0.06, h: 0.06, personId },
        { w: 0.3, h: 0.3, personId },
      ],
      async (db, _raw, _assetId, personId) => {
        const audit = await auditSubthresholdFaces(THRESHOLD, db);
        expect([...audit.personLoss.entries()]).toEqual([[personId, 2]]);
      },
    );
  });

  test('an asset with no sub-threshold face is scanned but not affected', async () => {
    await withFaces(
      () => [{ w: 0.3, h: 0.3 }],
      async (db) => {
        const audit = await auditSubthresholdFaces(THRESHOLD, db);
        expect(audit.assetsScanned).toBe(1);
        expect(audit.assetsAffected).toBe(0);
      },
    );
  });
});

describe('purgeSubthresholdFaces', () => {
  test('takes the visible unassigned faces and nothing else', async () => {
    await withFaces(
      (personId) => [
        { w: 0.05, h: 0.05 },
        { w: 0.05, h: 0.05, personId },
        { w: 0.05, h: 0.05, hidden: true },
        { w: 0.3, h: 0.3 },
      ],
      async (db, raw, assetId) => {
        const audit = await auditSubthresholdFaces(THRESHOLD, db);
        const outcome = await purgeSubthresholdFaces(THRESHOLD, false, db);
        // The delete removed exactly what the audit called unassigned.
        expect(outcome.facesRemoved).toBe(audit.unassigned);
        expect(outcome.assetsUpdated).toBe(1);
        expect(survivors(raw, assetId)).toEqual([1, 2, 3]);
      },
    );
  });

  test('takes the assigned ones too when opted in, and never the hidden one', async () => {
    await withFaces(
      (personId) => [
        { w: 0.05, h: 0.05 },
        { w: 0.05, h: 0.05, personId },
        { w: 0.05, h: 0.05, personId, hidden: true },
        { w: 0.3, h: 0.3 },
      ],
      async (db, raw, assetId) => {
        const audit = await auditSubthresholdFaces(THRESHOLD, db);
        const outcome = await purgeSubthresholdFaces(THRESHOLD, true, db);
        expect(outcome.facesRemoved).toBe(audit.unassigned + audit.assigned);
        expect(survivors(raw, assetId)).toEqual([2, 3]);
      },
    );
  });

  test('leaves the surviving faces at the indices they already had', async () => {
    // A face is a row, so a delete moves nothing. That is what a concurrent
    // per-index write depends on, and it is the difference from the array
    // `$pull` this replaced.
    await withFaces(
      () => [
        { w: 0.3, h: 0.3 },
        { w: 0.04, h: 0.04 },
        { w: 0.25, h: 0.25 },
      ],
      async (db, raw, assetId) => {
        await purgeSubthresholdFaces(THRESHOLD, false, db);
        expect(survivors(raw, assetId)).toEqual([0, 2]);
      },
    );
  });

  test('is idempotent — a second run at the same threshold takes nothing', async () => {
    await withFaces(
      () => [
        { w: 0.04, h: 0.04 },
        { w: 0.3, h: 0.3 },
      ],
      async (db) => {
        expect((await purgeSubthresholdFaces(THRESHOLD, false, db)).facesRemoved).toBe(1);
        const again = await purgeSubthresholdFaces(THRESHOLD, false, db);
        expect(again).toEqual({ facesRemoved: 0, assetsUpdated: 0 });
      },
    );
  });

  test('acts on a soft-deleted asset too — restoring it must not restore them', async () => {
    using handle = await createTestDatabase();
    const libraryId = insertFolder(handle.db, { slug: 'purge-deleted' });
    const assetId = seedSearchAsset(handle.db, libraryId, {
      capturedAt: null,
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
    insertFaceRow(handle.db, { assetId, faceIndex: 0, bbox: { x: 0, y: 0, w: 0.04, h: 0.04 } });
    const db = testSqliteDb(handle.db);

    expect((await auditSubthresholdFaces(THRESHOLD, db)).unassigned).toBe(1);
    expect((await purgeSubthresholdFaces(THRESHOLD, false, db)).facesRemoved).toBe(1);
    expect(survivors(handle.db, assetId)).toEqual([]);
  });
});
