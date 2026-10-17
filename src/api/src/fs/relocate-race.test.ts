import { afterEach, beforeEach, expect, test, spyOn, mock } from 'bun:test';
import * as fs from './mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';
import { relocateAsset } from '../library/relocate-asset.ts';
import { relocateFile, type CollisionPolicy } from './relocate.ts';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-race-'));
});
afterEach(async () => {
  mock.restore();
  setLibraryRootsForTests(null);
  await fs.rm(root, { recursive: true, force: true });
});
const abs = (rel: string) => path.join(root, rel);
const xmp =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4"/></rdf:RDF></x:xmpmeta>';
async function write(rel: string, bytes: string) {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.writeFile(abs(rel), bytes);
}

for (const collision of ['skip', 'auto-suffix', 'keep-both'] satisfies CollisionPolicy[]) {
  for (const raced of ['photo.dng', 'photo.xmp', 'photo.jpg']) {
    test(`${collision}: competing ${raced} survives publication`, async () => {
      await write('src/photo.dng', 'source pixels');
      await write('src/photo.xmp', xmp);
      await write('src/photo.jpg', 'source rendered');
      const prepared: string[] = [];
      let verified: unknown;
      const originalCopy = fs.copyFile;
      const copy =
        raced === 'photo.jpg'
          ? spyOn(fs, 'copyFile').mockImplementation(async (source, destination, flags) => {
              await originalCopy(source, destination, flags);
              if (String(destination).startsWith(abs('dst/photo.jpg.tmp.'))) {
                await write(`dst/${raced}`, 'competing bytes');
              }
            })
          : null;
      const outcome = await relocateFile({
        sourceAbsPath: abs('src/photo.dng'),
        destAbsPath: abs('dst/photo.dng'),
        mode: 'move',
        collision,
        extraCompanionAbsPaths: [abs('src/photo.jpg')],
        onDestinationPrepared: async (destination) => {
          prepared.push(destination);
          if (prepared.length === 1 && raced !== 'photo.jpg')
            await write(`dst/${raced}`, 'competing bytes');
        },
        onVerified: async (info) => {
          verified = info;
        },
      });
      copy?.mockRestore();
      expect(await fs.readFile(abs(`dst/${raced}`), 'utf8')).toBe('competing bytes');
      if (collision === 'skip') {
        expect(outcome).toEqual({ kind: 'skipped', reason: 'collision' });
        expect(verified).toBeUndefined();
        for (const [file, bytes] of [
          ['photo.dng', 'source pixels'],
          ['photo.xmp', xmp],
          ['photo.jpg', 'source rendered'],
        ]) {
          expect(await fs.readFile(abs(`src/${file}`), 'utf8')).toBe(bytes);
        }
      } else {
        expect(outcome.kind).toBe('relocated');
        if (outcome.kind !== 'relocated') throw new Error(JSON.stringify(outcome));
        const primary = abs('dst/photo.1.dng');
        expect(outcome.newAbsPath).toBe(primary);
        expect(prepared).toEqual([abs('dst/photo.dng'), primary]);
        expect(outcome.sidecarPaths).toEqual([abs('dst/photo.1.xmp')]);
        expect(outcome.companionPaths).toEqual([abs('dst/photo.1.jpg')]);
        expect(verified).toEqual({
          newAbsPath: primary,
          sidecarPaths: outcome.sidecarPaths,
          companionPaths: outcome.companionPaths,
        });
        expect(await fs.readFile(primary, 'utf8')).toBe('source pixels');
        expect(await fs.readFile(outcome.sidecarPaths[0], 'utf8')).toBe(xmp);
        expect(await fs.readFile(outcome.companionPaths[0], 'utf8')).toBe('source rendered');
        expect(await fs.readdir(abs('src'))).toEqual([]);
      }
      expect((await fs.readdir(abs('dst'))).some((name) => name.includes('.tmp.'))).toBe(false);
    });
  }
}

test('rollback preserves a published path subsequently replaced by another writer', async () => {
  await write('src/photo.dng', 'source pixels');
  const outcome = await relocateFile({
    sourceAbsPath: abs('src/photo.dng'),
    destAbsPath: abs('dst/photo.dng'),
    mode: 'move',
    collision: 'keep-both',
    onVerified: async ({ newAbsPath }) => {
      await write('replacement', 'replacement');
      await fs.rename(abs('replacement'), newAbsPath);
      throw new Error('repoint refused');
    },
  });
  expect(outcome.kind).toBe('error');
  expect(await fs.readFile(abs('dst/photo.dng'), 'utf8')).toBe('replacement');
  expect(await fs.readFile(abs('src/photo.dng'), 'utf8')).toBe('source pixels');
});

test('catalog and response use the name actually published after a race', async () => {
  using live = await createLiveTestDatabase();
  await write('src/photo.dng', 'source pixels');
  await write('src/photo.xmp', xmp);
  await write('src/photo.jpg', 'source rendered');
  const libraryId = insertFolder(live.db, { path: root, slug: 'relocate-race' });
  const assetId = insertAsset(live.db);
  insertLocation(live.db, { assetId, libraryId, path: 'src', filename: 'photo.dng' });
  setLibraryRootsForTests(new Map([[libraryId, root]]));
  const originalLink = fs.link;
  spyOn(fs, 'link').mockImplementation(async (source, destination) => {
    if (destination === abs('dst/photo.dng')) await write('dst/photo.dng', 'competing pixels');
    await originalLink(source, destination);
  });
  const result = await relocateAsset({
    id: new ObjectId(assetId),
    mode: 'move',
    collision: 'keep-both',
    destinationPath: 'dst',
    renderedCompanionAbsPath: abs('src/photo.jpg'),
  });
  expect(result).toMatchObject({
    kind: 'relocated',
    newPath: 'dst',
    newFilename: 'photo.1.dng',
    newAbsPath: abs('dst/photo.1.dng'),
    renamedOnCollision: true,
  });
  expect(
    live.db.query('SELECT path, filename FROM asset_locations WHERE asset_id = ?').get(assetId),
  ).toMatchObject({ path: 'dst', filename: 'photo.1.dng' });
  expect(
    live.db.query('SELECT apple_rendered_path FROM assets WHERE id = ?').get(assetId),
  ).toMatchObject({ apple_rendered_path: 'dst/photo.1.jpg' });
  expect(await fs.readFile(abs('dst/photo.dng'), 'utf8')).toBe('competing pixels');
  expect(await fs.readFile(abs('dst/photo.1.xmp'), 'utf8')).toBe(xmp);
  expect(await fs.readFile(abs('dst/photo.1.jpg'), 'utf8')).toBe('source rendered');
});

for (const occupied of [false, true]) {
  test(`EXDEV fallback uses exclusive copy (occupied: ${occupied})`, async () => {
    await write('src/photo.dng', 'source pixels');
    spyOn(fs, 'link').mockImplementation(async () => {
      throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
    });
    const result = await relocateFile({
      sourceAbsPath: abs('src/photo.dng'),
      destAbsPath: abs('dst/photo.dng'),
      mode: 'copy',
      collision: 'skip',
      onDestinationPrepared: async () => {
        if (occupied) await write('dst/photo.dng', 'competing pixels');
      },
    });
    expect(result.kind).toBe(occupied ? 'skipped' : 'relocated');
    expect(await fs.readFile(abs('dst/photo.dng'), 'utf8')).toBe(
      occupied ? 'competing pixels' : 'source pixels',
    );
    expect(await fs.readFile(abs('src/photo.dng'), 'utf8')).toBe('source pixels');
    expect(await fs.readdir(abs('dst'))).toEqual(['photo.dng']);
  });
}
