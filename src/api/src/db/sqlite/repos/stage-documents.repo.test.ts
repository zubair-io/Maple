/**
 * The document a stage handler receives, rebuilt from six tables.
 *
 * The contract under test is "what the BSON document held, the rows still
 * hold": a handler that read `doc.fileinfo[0].filename`, `doc.exif.iso`,
 * `doc.vision.caption` or a sibling stage's `last_error` keeps working. The
 * asserted cases are the ones where a row and a document genuinely differ — a
 * column that is absent versus null, a payload that lives in a side table, and
 * a timestamp that is TEXT here and was a `Date` there.
 */

import { describe, expect, it } from 'bun:test';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  testSqliteDb,
} from '../test-sqlite.test-helpers.ts';
import { loadStageDocuments } from './stage-documents.repo.ts';

describe('loadStageDocuments', () => {
  it('returns nothing for an empty id list, without touching the database', async () => {
    using handle = await createTestDatabase();
    expect(await loadStageDocuments([], testSqliteDb(handle.db))).toEqual(new Map());
  });

  it('omits an id with no asset row rather than inventing a blank document', async () => {
    // An asset can be hard-deleted between the claim and this load. A blank
    // document would reach a handler with an empty `fileinfo` it cannot tell
    // apart from an unindexed file.
    using handle = await createTestDatabase();
    const docs = await loadStageDocuments(['a'.repeat(24)], testSqliteDb(handle.db));
    expect(docs.size).toBe(0);
  });

  it('rebuilds the locations, the EXIF payload and the asset columns', async () => {
    using handle = await createTestDatabase();
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db, { exif: JSON.stringify({ iso: 400 }) });
    insertLocation(handle.db, { assetId, libraryId, path: 'a/b', filename: 'IMG_1.dng' });
    insertLocation(handle.db, {
      assetId,
      libraryId,
      ordinal: 1,
      path: 'c',
      filename: 'IMG_1.dng',
      missingSince: '2026-01-01T00:00:00Z',
    });
    handle.db.run(
      `UPDATE assets SET media_kind = 'video', maple_id = 'abc', rating = 4 WHERE id = ?`,
      [assetId],
    );

    const doc = (await loadStageDocuments([assetId], testSqliteDb(handle.db))).get(assetId)!;

    expect(doc._id.toHexString()).toBe(assetId);
    expect(doc.fileinfo).toHaveLength(2);
    expect(doc.fileinfo?.[0]).toMatchObject({ path: 'a/b', filename: 'IMG_1.dng' });
    // A tombstoned location keeps its marker, which is what the liveness
    // helpers the handlers share read.
    expect(doc.fileinfo?.[1]?.missing_since).toBe('2026-01-01T00:00:00Z');
    expect(doc.exif as unknown).toEqual({ iso: 400 });
    expect(doc.rating).toBe(4);
    expect(doc.maple_id).toBe('abc');
    expect((doc as unknown as { media_kind: string }).media_kind).toBe('video');
  });

  it('leaves an unset optional column as an absent key, not a null one', async () => {
    // Several handlers branch on presence — `maple_id`, `apple_rendered_path`,
    // `cf_thumb_synced_at` — and a `null` would be a different answer.
    using handle = await createTestDatabase();
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, { assetId, libraryId });

    const doc = (await loadStageDocuments([assetId], testSqliteDb(handle.db))).get(assetId)!;

    expect('maple_id' in doc).toBe(false);
    expect('damaged' in doc).toBe(false);
    expect((doc as unknown as Record<string, unknown>)['cf_thumb_synced_at']).toBeUndefined();
  });

  it('carries the damaged tag as the subdocument it replaces', async () => {
    using handle = await createTestDatabase();
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, { assetId, libraryId });
    handle.db.run(
      `UPDATE assets SET damaged_since = '2026-01-01T00:00:00Z', damaged_stage = 'exif',
              damaged_reason = 'bad bytes' WHERE id = ?`,
      [assetId],
    );

    const doc = (await loadStageDocuments([assetId], testSqliteDb(handle.db))).get(assetId)!;

    expect((doc as unknown as { damaged: unknown }).damaged).toEqual({
      since: '2026-01-01T00:00:00Z',
      stage: 'exif',
      reason: 'bad bytes',
    });
  });

  it('rebuilds the detail payloads and the per-stage bookkeeping', async () => {
    using handle = await createTestDatabase();
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, { assetId, libraryId });
    handle.db.run(
      `INSERT INTO asset_detail (asset_id, description, ocr_text, vision)
       VALUES (?, 'a cat', 'HELLO', json('{"caption":"a cat"}'))`,
      [assetId],
    );
    handle.db.run(
      `INSERT INTO stage_state (asset_id, stage, version, attempts, last_error, processed_at)
       VALUES (?, 'preview', 2, 0, 'skip: video', '2026-01-01T00:00:00Z')`,
      [assetId],
    );

    const doc = (await loadStageDocuments([assetId], testSqliteDb(handle.db))).get(assetId)!;

    expect(doc.description).toBe('a cat');
    expect(doc.ocr_text).toBe('HELLO');
    expect(doc.vision).toEqual({ caption: 'a cat' } as never);
    // `describe` reads exactly this to decide whether preview skipped it.
    expect(doc.stages?.preview?.last_error).toBe('skip: video');
    expect(doc.stages?.preview?.version).toBe(2);
    // A TEXT column, but the document promised a Date and handlers compare it.
    expect(doc.stages?.preview?.processed_at).toBeInstanceOf(Date);
  });

  it('loads a whole batch in one call, grouped per asset', async () => {
    using handle = await createTestDatabase();
    const libraryId = insertFolder(handle.db);
    const ids = Array.from({ length: 3 }, (_unused, i) => {
      const assetId = insertAsset(handle.db);
      insertLocation(handle.db, { assetId, libraryId, path: `dir-${i}` });
      return assetId;
    });

    const docs = await loadStageDocuments(ids, testSqliteDb(handle.db));

    expect(docs.size).toBe(3);
    for (const id of ids) expect(docs.get(id)?.fileinfo).toHaveLength(1);
  });
});
