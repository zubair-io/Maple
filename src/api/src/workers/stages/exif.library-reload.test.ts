import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import { createLiveTestDatabase, insertFolder } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import {
  UNKNOWN_LIBRARY_RELOAD_MIN_INTERVAL_MS,
  invalidateLibraryRoots,
  loadLibraryRoots,
} from '../../indexer/libraries.cache.ts';
import { solidJpeg } from '../../test-support/synth-image.ts';
import exifStage from './exif.ts';

describe('exif handler with a library registered after the worker cached the roots', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'exif-reload-'));
  });
  afterEach(() => {
    invalidateLibraryRoots();
    setSystemTime();
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const docIn = (libraryId: string, filename: string) => ({
    _id: new ObjectId('000000000000000000000002'),
    fileinfo: [{ path: '', filename, library_id: new ObjectId(libraryId), deleted_at: null }],
    sha1_head: 'a'.repeat(40),
    maple_id: 'b'.repeat(32),
  });

  it('resolves the file once the folders table has the new library', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: path.join(dir, 'original') });
    await loadLibraryRoots();
    setSystemTime(new Date(Date.now() + UNKNOWN_LIBRARY_RELOAD_MIN_INTERVAL_MS + 1));
    await writeFile(path.join(dir, 'late.jpg'), await solidJpeg(4, 4, [0, 0, 0]));
    const addedByApiProcess = insertFolder(live.db, { path: dir });

    const result = await exifStage.handler(
      docIn(addedByApiProcess, 'late.jpg') as never,
      {} as never,
    );

    expect('patch' in result).toBe(true);
  });

  it('defers instead of skipping when the library is still unregistered', async () => {
    using live = await createLiveTestDatabase();
    insertFolder(live.db, { path: path.join(dir, 'original') });

    const result = await exifStage.handler(
      docIn(new ObjectId().toHexString(), 'late.jpg') as never,
      {} as never,
    );

    expect(result).toMatchObject({ defer: { reason: 'library-not-registered' } });
  });

  it('still skips an asset with no live location', async () => {
    using live = await createLiveTestDatabase();
    void live;
    const result = await exifStage.handler(
      { ...docIn(new ObjectId().toHexString(), 'x.jpg'), fileinfo: [] } as never,
      {} as never,
    );

    expect(result).toEqual({ skip: 'no-resolvable-location' });
  });
});
