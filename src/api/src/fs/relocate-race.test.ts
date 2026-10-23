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
      // A companion name is suffixed on its own, as for a pre-existing occupant.
      const companionRaced = raced === 'photo.jpg';
      if (collision === 'skip' && !companionRaced) {
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
        const stem = companionRaced ? 'dst/photo' : 'dst/photo.1';
        const primary = abs(`${stem}.dng`);
        expect(outcome.newAbsPath).toBe(primary);
        expect(prepared).toEqual(companionRaced ? [primary] : [abs('dst/photo.dng'), primary]);
        expect(outcome.sidecarPaths).toEqual([abs(`${stem}.xmp`)]);
        expect(outcome.companionPaths).toEqual([abs('dst/photo.1.jpg')]);
        expect(verified).toEqual({
          newAbsPath: primary,
          sidecarPaths: outcome.sidecarPaths,
          companionPaths: outcome.companionPaths,
          companionSources: [abs('src/photo.jpg')],
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

for (const fallback of [false, true]) {
  test(`rollback preserves a replacement file (fallback: ${fallback})`, async () => {
    await write('src/photo.dng', 'source pixels');
    await write('replacement', 'competing pixels');
    const destination = abs('dst/photo.dng');
    const replace = async () => {
      if (await fs.stat(abs('replacement')).catch(() => null))
        await fs.rename(abs('replacement'), destination);
    };
    if (fallback) {
      spyOn(fs, 'link').mockRejectedValue(
        Object.assign(new Error('unsupported'), { code: 'EPERM' }),
      );
      const copy = fs.copyFile;
      spyOn(fs, 'copyFile').mockImplementation(async (source, target, flags) => {
        await copy(source, target, flags);
        if (target === destination) await replace();
      });
      const open = fs.open;
      spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
        const handle = await open(target, flags, mode);
        if (target === destination) await replace();
        return handle;
      });
    }
    const outcome = await relocateFile({
      sourceAbsPath: abs('src/photo.dng'),
      destAbsPath: destination,
      mode: 'move',
      collision: 'keep-both',
      onVerified: async () => {
        await replace();
        throw new Error('catalog repoint refused');
      },
    });
    expect(outcome.kind).toBe('error');
    expect(await fs.readFile(destination, 'utf8')).toBe('competing pixels');
    expect(await fs.readFile(abs('src/photo.dng'), 'utf8')).toBe('source pixels');
  });
}

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
    appleCompanionAbsPaths: { apple_rendered_path: abs('src/photo.jpg') },
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

for (const code of ['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOSYS']) {
  for (const occupied of [false, true]) {
    test(`${code} fallback uses exclusive copy (occupied: ${occupied})`, async () => {
      await write('src/photo.dng', 'source pixels');
      spyOn(fs, 'link').mockImplementation(async () => {
        throw Object.assign(new Error('cross device'), { code });
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
}

test('late collision resumes after the initially chosen suffix', async () => {
  await write('src/photo.dng', 'source pixels');
  for (const suffix of ['', '.1', '.2', '.3', '.4'])
    await write(`dst/photo${suffix}.dng`, 'occupied');
  const prepared: string[] = [];
  const originalCopy = fs.copyFile;
  const copy = spyOn(fs, 'copyFile').mockImplementation(originalCopy);
  const result = await relocateFile({
    sourceAbsPath: abs('src/photo.dng'),
    destAbsPath: abs('dst/photo.dng'),
    mode: 'move',
    collision: 'keep-both',
    onDestinationPrepared: async (destination) => {
      prepared.push(destination);
      if (prepared.length === 1) await write('dst/photo.5.dng', 'competing pixels');
    },
  });
  expect(result).toMatchObject({ kind: 'relocated', newAbsPath: abs('dst/photo.6.dng') });
  expect(prepared).toEqual([abs('dst/photo.5.dng'), abs('dst/photo.6.dng')]);
  expect(copy).toHaveBeenCalledTimes(2);
  expect(await fs.readFile(abs('dst/photo.5.dng'), 'utf8')).toBe('competing pixels');
});

for (const collision of ['skip', 'keep-both'] satisfies CollisionPolicy[]) {
  test(`${collision}: a fallback copy renamed over mid-write is not reported as the move`, async () => {
    await write('src/photo.dng', 'source pixels');
    await write('replacement', 'competing pixels');
    const destination = abs('dst/photo.dng');
    spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'EPERM' }));
    const open = fs.open;
    let raced = false;
    spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if (target === destination && !raced) {
        raced = true;
        await fs.rename(abs('replacement'), destination);
      }
      return handle;
    });
    const outcome = await relocateFile({
      sourceAbsPath: abs('src/photo.dng'),
      destAbsPath: destination,
      mode: 'move',
      collision,
    });
    expect(raced).toBe(true);
    expect(await fs.readFile(destination, 'utf8')).toBe('competing pixels');
    if (collision === 'skip') {
      expect(outcome).toEqual({ kind: 'skipped', reason: 'collision' });
      expect(await fs.readFile(abs('src/photo.dng'), 'utf8')).toBe('source pixels');
    } else {
      expect(outcome).toMatchObject({ kind: 'relocated', newAbsPath: abs('dst/photo.1.dng') });
      expect(await fs.readFile(abs('dst/photo.1.dng'), 'utf8')).toBe('source pixels');
      expect(await fs.readdir(abs('src'))).toEqual([]);
    }
  });
}

for (const cap of [3, 0]) {
  test(`fallback copy with writes capped at ${cap} bytes never truncates the moved file`, async () => {
    const pixels = 'source pixels '.repeat(64);
    await write('src/photo.dng', pixels);
    const destination = abs('dst/photo.dng');
    spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'EPERM' }));
    const open = fs.open;
    spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if (target !== destination) return handle;
      const original = handle.write.bind(handle) as (...args: unknown[]) => Promise<unknown>;
      const capped = (
        buffer: Buffer,
        offset = 0,
        length = buffer.length - offset,
        position?: number,
      ) => original(buffer, offset, Math.min(cap, length), position);
      handle.write = capped as typeof handle.write;
      return handle;
    });
    const outcome = await relocateFile({
      sourceAbsPath: abs('src/photo.dng'),
      destAbsPath: destination,
      mode: 'move',
      collision: 'keep-both',
    });
    if (outcome.kind === 'relocated') {
      expect(await fs.readFile(outcome.newAbsPath, 'utf8')).toBe(pixels);
    } else {
      expect(outcome.kind).toBe('error');
      expect(await fs.readFile(abs('src/photo.dng'), 'utf8')).toBe(pixels);
      expect(await fs.readdir(abs('dst'))).toEqual([]);
    }
    expect(outcome.kind).toBe(cap > 0 ? 'relocated' : 'error');
  });
}

for (const collision of ['skip', 'keep-both'] satisfies CollisionPolicy[]) {
  test(`${collision}: a failed fallback revalidation withdraws the new file`, async () => {
    await write('src/photo.dng', 'source pixels');
    const destination = abs('dst/photo.dng');
    spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'EPERM' }));
    const open = fs.open;
    let created = false;
    spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if (target === destination) created = true;
      return handle;
    });
    const lstat = fs.lstat;
    let failed = false;
    spyOn(fs, 'lstat').mockImplementation((async (target: string, options?: unknown) => {
      if (target === destination && created && !failed) {
        failed = true;
        throw Object.assign(new Error('transient'), { code: 'EIO' });
      }
      return (lstat as (...args: unknown[]) => Promise<unknown>)(target, options);
    }) as typeof fs.lstat);
    const outcome = await relocateFile({
      sourceAbsPath: abs('src/photo.dng'),
      destAbsPath: destination,
      mode: 'move',
      collision,
    });
    expect(failed).toBe(true);
    expect(outcome.kind).toBe('error');
    expect(await fs.readFile(abs('src/photo.dng'), 'utf8')).toBe('source pixels');
    expect(await fs.readdir(abs('dst'))).toEqual([]);
  });
}

const transient = () => Object.assign(new Error('transient'), { code: 'EIO' });

test('a hard-link publication whose identity read fails leaves no duplicate', async () => {
  await write('src/photo.dng', 'source pixels');
  const tmpPrefix = abs('dst/photo.dng.tmp.');
  const lstat = fs.lstat;
  let failed = false;
  spyOn(fs, 'lstat').mockImplementation((async (target: string, options?: unknown) => {
    if (String(target).startsWith(tmpPrefix) && !failed) {
      failed = true;
      throw transient();
    }
    return (lstat as (...args: unknown[]) => Promise<unknown>)(target, options);
  }) as typeof fs.lstat);
  const outcome = await relocateFile({
    sourceAbsPath: abs('src/photo.dng'),
    destAbsPath: abs('dst/photo.dng'),
    mode: 'move',
    collision: 'keep-both',
  });
  expect(failed).toBe(true);
  expect(outcome.kind).toBe('error');
  expect(await fs.readFile(abs('src/photo.dng'), 'utf8')).toBe('source pixels');
  expect(await fs.readdir(abs('dst'))).toEqual([]);
});

for (const statFailures of [1, Infinity]) {
  test(`fallback handle stat failing ${statFailures}x never strands the created file`, async () => {
    await write('src/photo.dng', 'source pixels');
    const destination = abs('dst/photo.dng');
    spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'EPERM' }));
    const open = fs.open;
    let failures = 0;
    spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if (target !== destination) return handle;
      const stat = handle.stat.bind(handle);
      handle.stat = (async (options?: unknown) => {
        if (failures < statFailures) {
          failures++;
          throw transient();
        }
        return stat(options as never);
      }) as typeof handle.stat;
      return handle;
    });
    const outcome = await relocateFile({
      sourceAbsPath: abs('src/photo.dng'),
      destAbsPath: destination,
      mode: 'move',
      collision: 'keep-both',
    });
    expect(failures).toBeGreaterThan(0);
    if (statFailures === 1) {
      expect(outcome).toMatchObject({ kind: 'relocated', newAbsPath: destination });
      expect(await fs.readFile(destination, 'utf8')).toBe('source pixels');
    } else {
      expect(outcome.kind).toBe('error');
      expect(await fs.readFile(abs('src/photo.dng'), 'utf8')).toBe('source pixels');
      expect(await fs.readdir(abs('dst'))).toEqual([]);
    }
  });
}

test('an unprovable fallback file is kept rather than deleted', async () => {
  await write('src/photo.dng', 'source pixels');
  const destination = abs('dst/photo.dng');
  spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'EPERM' }));
  const open = fs.open;
  spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
    const handle = await open(target, flags, mode);
    if (target === destination) {
      handle.stat = (async () => {
        throw transient();
      }) as typeof handle.stat;
    }
    return handle;
  });
  const readFile = fs.readFile;
  spyOn(fs, 'readFile').mockImplementation((async (target: unknown, options?: unknown) => {
    if (String(target).startsWith(`${destination}.tmp.`)) throw transient();
    return (readFile as (...args: unknown[]) => Promise<unknown>)(target, options);
  }) as typeof fs.readFile);
  const outcome = await relocateFile({
    sourceAbsPath: abs('src/photo.dng'),
    destAbsPath: destination,
    mode: 'move',
    collision: 'keep-both',
  });
  expect(outcome.kind).toBe('error');
  expect(await fs.readFile(abs('src/photo.dng'), 'utf8')).toBe('source pixels');
  expect(await fs.readdir(abs('dst'))).toHaveLength(1);
});

test('rollback never removes a file that replaced the publication just before removal', async () => {
  await write('src/photo.dng', 'source pixels');
  await write('replacement', 'competing pixels');
  const destination = abs('dst/photo.dng');
  const replace = async () => {
    if (await fs.lstat(abs('replacement')).catch(() => null))
      await fs.rename(abs('replacement'), destination);
  };
  const unlink = fs.unlink;
  spyOn(fs, 'unlink').mockImplementation(async (target) => {
    if (target === destination) await replace();
    return unlink(target);
  });
  const rename = fs.rename;
  spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (from === destination) await replace();
    return rename(from, to);
  });
  const outcome = await relocateFile({
    sourceAbsPath: abs('src/photo.dng'),
    destAbsPath: destination,
    mode: 'move',
    collision: 'keep-both',
    onVerified: async () => {
      throw new Error('catalog repoint refused');
    },
  });
  expect(outcome.kind).toBe('error');
  expect(await fs.lstat(abs('replacement')).catch(() => null)).toBeNull();
  expect(await fs.readFile(destination, 'utf8')).toBe('competing pixels');
  expect(await fs.readFile(abs('src/photo.dng'), 'utf8')).toBe('source pixels');
  expect(await fs.readdir(abs('dst'))).toEqual(['photo.dng']);
});
