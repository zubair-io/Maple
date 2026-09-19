/**
 * The sidecar-metadata-index stage's projection onto the asset row: rating,
 * flag, colour label, the `is_screenshot` verdict and visibility.
 *
 * Split out of `sidecar-metadata-index.test.ts` for the file budget, the same
 * reason the relocate e2e suites are three files. Shared fixtures are in
 * `sidecar-metadata-index.test-helpers.ts`.
 *
 * Most cases read the run back from its statements, which is enough when the
 * question is what the handler decided. The last one runs the statements
 * against a real SQLite database, because two things are only observable there:
 * that `is_screenshot` lands as 0 rather than staying NULL — the column is
 * tri-state and NULL means "never classified" — and that a sidecar saying
 * nothing about visibility leaves an existing `hidden_reason` alone rather than
 * blanking it.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ObjectId } from '../../db/object-id.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  testSqliteDb,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import type { ImageDoc } from '../run-stage.ts';
import { sidecarMetadataIndexHandler } from './sidecar-metadata-index.ts';
import {
  FAKE_LIB_ID,
  fakeCtx,
  makeImage,
  makeXmp,
  useTempLibrary,
  writeSidecar,
  writeVideoSidecar,
  written,
} from './sidecar-metadata-index.test-helpers.ts';

const library = useTempLibrary();

describe('culling projection', () => {
  test('rating in sidecar is projected to metadata_override and the asset row', async () => {
    const image = await writeSidecar(
      library,
      makeXmp('xmp:Rating="4" xmlns:xmp="http://ns.adobe.com/xap/1.0/"'),
    );
    const { columns, override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect(override['rating']).toBe(4);
    expect(columns['rating']).toBe(4);
  });

  test('flag=pick is projected to metadata_override and the asset row (flag=1)', async () => {
    const image = await writeSidecar(
      library,
      makeXmp('papp:Flag="pick" xmlns:papp="http://ns.justmaple.app/photo/1.0/"'),
    );
    const { columns, override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect(override['flag']).toBe('pick');
    expect(columns['flag']).toBe(1);
  });

  test('flag=reject is projected to metadata_override and the asset row (flag=-1)', async () => {
    const image = await writeSidecar(
      library,
      makeXmp('papp:Flag="reject" xmlns:papp="http://ns.justmaple.app/photo/1.0/"'),
    );
    const { columns, override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect(override['flag']).toBe('reject');
    expect(columns['flag']).toBe(-1);
  });

  test('cleared culling overwrites a stale rating/flag with the defaults', async () => {
    // Asset previously had flag=pick (1) and rating=5; the sidecar now carries
    // other metadata (a city) but NO culling attrs — the user cleared them. The
    // sidecar is authoritative, so the projection must reset the stale row
    // values to the insert defaults (rating 0, flag 0), not leave them in place.
    await fs.writeFile(path.join(library.dir, 'test.dng'), '');
    await fs.writeFile(
      path.join(library.dir, 'test.xmp'),
      makeXmp('photoshop:City="Berlin"'),
      'utf-8',
    );
    const image = makeImage({ rating: 5, flag: 1 });

    const { columns, override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    // metadata_override carries only the present (non-culling) field…
    expect(override['rating']).toBeUndefined();
    expect(override['flag']).toBeUndefined();
    // …but the projection resets the stale values to cleared defaults.
    expect(columns['rating']).toBe(0);
    expect(columns['flag']).toBe(0);
    expect(columns['color_label']).toBe('');
  });

  test('isScreenshot=true is projected to metadata_override and the asset row', async () => {
    const image = await writeSidecar(
      library,
      makeXmp('papp:IsScreenshot="true" xmlns:papp="http://ns.justmaple.app/photo/1.0/"'),
    );
    const { columns, override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect(override['is_screenshot']).toBe(true);
    // The column is an INTEGER, so the projected verdict is 1, never `true`.
    expect(columns['is_screenshot']).toBe(1);
  });

  test('isScreenshot=false is projected to metadata_override and the asset row', async () => {
    const image = await writeSidecar(
      library,
      makeXmp('papp:IsScreenshot="false" xmlns:papp="http://ns.justmaple.app/photo/1.0/"'),
    );
    const { columns, override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect(override['is_screenshot']).toBe(false);
    expect(columns['is_screenshot']).toBe(0);
  });

  test('absent isScreenshot reverts to the native verdict (photo false, screenshot true)', async () => {
    // 1. Photo case: test.xmp exists with metadata, and has no isScreenshot.
    await fs.writeFile(path.join(library.dir, 'test.dng'), '');
    await fs.writeFile(
      path.join(library.dir, 'test.xmp'),
      makeXmp('photoshop:City="Berlin"'),
      'utf-8',
    );
    const photo = written(
      await sidecarMetadataIndexHandler(makeImage({ is_screenshot: true }), fakeCtx),
    );
    expect(photo.columns['is_screenshot']).toBe(0);

    // 2. Screenshot case: same, for a filename the heuristic recognises.
    await fs.writeFile(path.join(library.dir, 'Screenshot_123.png'), '');
    await fs.writeFile(
      path.join(library.dir, 'Screenshot_123.xmp'),
      makeXmp('photoshop:City="Berlin"'),
      'utf-8',
    );
    const screenshotImage = makeImage({
      is_screenshot: false,
      fileinfo: [
        {
          path: '',
          filename: 'Screenshot_123.png',
          library_id: { toHexString: () => FAKE_LIB_ID } as unknown as ObjectId,
        },
      ],
    });
    const { columns } = written(await sidecarMetadataIndexHandler(screenshotImage, fakeCtx));
    expect(columns['is_screenshot']).toBe(1);
  });

  // `is_screenshot` is a stills-only concept (#2325). The still-image control
  // for these is the `isScreenshot=true` case above, which must keep passing.
  test('a video with an explicit isScreenshot=true override still projects false', async () => {
    const image = await writeVideoSidecar(
      library,
      makeXmp('papp:IsScreenshot="true" xmlns:papp="http://ns.justmaple.app/photo/1.0/"'),
    );
    const { columns, override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    // The user's sidecar value is preserved verbatim — XMP is the contract and
    // this is their data…
    expect(override['is_screenshot']).toBe(true);
    // …but the projected column that search, the facet counts and the
    // Photos/Screenshots filter read honours the stills-only invariant.
    expect(columns['is_screenshot']).toBe(0);
  });

  test('a video with a stored vision verdict of true still projects false', async () => {
    const image = await writeVideoSidecar(library, makeXmp('photoshop:City="Berlin"'));
    const withVision = {
      ...image,
      vision: { is_screenshot: true, caption: 'a UI' },
    } as unknown as ImageDoc;
    const { columns } = written(await sidecarMetadataIndexHandler(withVision, fakeCtx));
    expect(columns['is_screenshot']).toBe(0);
  });
});

interface ProjectedRow {
  rating: number;
  flag: number;
  color_label: string;
  is_screenshot: number | null;
  hidden: number;
  hidden_reason: string | null;
}

describe('the projection applied to a database', () => {
  test('writes the five columns and the override document, leaving hidden_reason alone', async () => {
    using handle = await createTestDatabase();
    const libraryId = insertFolder(handle.db, { path: library.dir });
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, { assetId, libraryId, path: '', filename: 'test.dng' });
    setLibraryRootsForTests(new Map([[libraryId, library.dir]]));
    // A stored reason the sidecar says nothing about: the classifier hid this
    // asset, and reconciling an unrelated sidecar edit must not erase why.
    handle.db.run(`UPDATE assets SET hidden = 1, hidden_reason = 'nudity' WHERE id = ?`, [assetId]);

    await fs.writeFile(path.join(library.dir, 'test.dng'), '');
    await fs.writeFile(
      path.join(library.dir, 'test.xmp'),
      makeXmp('xmp:Rating="4" xmlns:xmp="http://ns.adobe.com/xap/1.0/"'),
      'utf-8',
    );

    const image = makeImage({
      _id: { toHexString: () => assetId } as unknown as ObjectId,
      hidden: true,
      fileinfo: [
        {
          path: '',
          filename: 'test.dng',
          library_id: { toHexString: () => libraryId } as unknown as ObjectId,
        },
      ],
    });
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    if (!('patch' in result)) throw new Error('Expected patch result');
    await testSqliteDb(handle.db).transaction([...result.patch]);

    const row = handle.db
      .query(
        `SELECT rating, flag, color_label, is_screenshot, hidden, hidden_reason
           FROM assets WHERE id = ?`,
      )
      .get(assetId) as ProjectedRow;
    expect(row.rating).toBe(4);
    expect(row.flag).toBe(0);
    expect(row.color_label).toBe('');
    // The column is tri-state and NULL means "never classified". The row was
    // seeded NULL, and a run that reached the projection has classified it.
    expect(row.is_screenshot).toBe(0);
    // No visibility attribute in the sidecar, so the prior state and its reason
    // both survive.
    expect(row.hidden).toBe(1);
    expect(row.hidden_reason).toBe('nudity');

    const detail = handle.db
      .query(`SELECT metadata_override FROM asset_detail WHERE asset_id = ?`)
      .get(assetId) as { metadata_override: string };
    expect(JSON.parse(detail.metadata_override)).toMatchObject({ rating: 4 });
  });
});
