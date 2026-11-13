/** #1472: a failed catalogue commit with real RAW/XMP and native pixels. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { maple } from 'maple';
import * as fs from '../fs/mirrored.ts';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { setSqliteHandleForTests } from '../db/sqlite/index.ts';
import { loadAssetLocationView } from '../db/repos/assets.locations.repo.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { nativeLibAvailable } from '../ffi/raw_ffi.ts';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { removalJournalPath } from '../fs/removal-relocation-journal.ts';
import { relocateAsset } from './relocate-asset.ts';

const fixture = resolve(import.meta.dir, '../../../../test-fixtures/removal/calibration');
describe.skipIf(!nativeLibAvailable())('Removal catalogue acknowledgement loss (#1472)', () => {
  let root: string;
  let source: string;
  let target: string;
  let xml: string;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-removal-catalogue-')));
    source = join(root, 'source/photo.dng');
    target = join(root, 'destination/renamed.dng');
    await fs.mkdir(join(dirname(source), '.maple/inpaint'), { recursive: true });
    await fs.mkdir(dirname(target));
    await fs.copyFile(join(fixture, 'source.dng'), source);
    await fs.copyFile(join(fixture, 'saved.xmp'), source.replace('.dng', '.xmp'));
    xml = await fs.readFile(source.replace('.dng', '.xmp'), 'utf8');
    const [record] = JSON.parse(await fs.readFile(join(fixture, 'records.txt'), 'utf8'));
    await fs.copyFile(
      join(fixture, 'mask.mimf'),
      join(dirname(source), '.maple/inpaint', `${record.accepted.mask.slice(7)}.mask`),
    );
    await fs.copyFile(
      join(fixture, 'patch.f16'),
      join(dirname(source), '.maple/inpaint', `${record.patch.slice(7)}.f16`),
    );
    await fs.writeFile(target, 'unindexed previous original');
    await fs.writeFile(target.replace('.dng', '.xmp'), 'unindexed previous edits');
  });
  afterEach(async () => {
    setLibraryRootsForTests(null);
    await fs.rm(root, { recursive: true, force: true });
  });
  afterAll(() => ffiPool().shutdown());

  async function assertPixels(raw: string) {
    expect(await fs.readFile(raw)).toEqual(await fs.readFile(join(fixture, 'source.dng')));
    expect(await fs.readFile(raw.replace('.dng', '.xmp'), 'utf8')).toBe(xml);
    const output = join(root, `actual-${randomUUID()}.png`);
    expect(
      await ffiPool().exportRecipeToFile(
        raw,
        xml,
        JSON.stringify({ ...DEFAULT_EXPORT_RECIPE, format: 'png', quality: null }),
        null,
        output,
      ),
    ).toBe(true);
    expect(Buffer.from((await maple(output).toRaw()).data)).toEqual(
      await fs.readFile(join(fixture, 'preview-64.rgb')),
    );
  }

  it('a catalogue failure before commit keeps the saved edit at its source', async () => {
    using live = await createLiveTestDatabase();
    const folder = insertFolder(live.db, { path: root });
    const asset = insertAsset(live.db);
    insertLocation(live.db, {
      assetId: asset,
      libraryId: folder,
      path: 'source',
      filename: 'photo.dng',
    });
    const id = new ObjectId(asset);
    setLibraryRootsForTests(new Map([[folder, root]]));
    let injected = false;
    const previous = setSqliteHandleForTests({
      ...live.handle,
      transaction: async () => {
        expect(injected).toBe(false);
        injected = true;
        throw new Error('catalogue acknowledgement unavailable');
      },
    });
    try {
      const outcome = await relocateAsset({
        id,
        mode: 'move',
        collision: 'replace',
        destinationPath: 'destination',
        destinationFilename: 'renamed.dng',
      });
      expect(outcome.kind).toBe('error');
      expect(outcome.kind === 'error' && outcome.error).toContain('acknowledgement');
      expect(injected).toBe(true);
    } finally {
      setSqliteHandleForTests(previous);
    }
    const location = (await loadAssetLocationView(id))!.fileinfo[0];
    expect(location.path).toBe('source');
    expect(location.filename).toBe('photo.dng');
    await assertPixels(source);
    expect(await fs.readFile(target, 'utf8')).toBe('unindexed previous original');
    expect(await fs.readFile(target.replace('.dng', '.xmp'), 'utf8')).toBe(
      'unindexed previous edits',
    );
    await expect(fs.stat(removalJournalPath(target))).rejects.toThrow();
  }, 30_000);
});
