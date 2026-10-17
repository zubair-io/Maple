/**
 * #4701: the geo relocate's byte-identical dedupe must never unlink the only
 * original. When the target folder is a directory symlink or a case alias of
 * the source folder, the "destination" IS the source; comparing it to itself
 * reports identical bytes, and the dedupe used to delete the one real file and
 * repoint the catalogue at a path that no longer exists.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import {
  SLUG,
  clearLibraryCache,
  locationOf,
  postRelocate,
  seedRelocatableAsset,
  usPlaceText,
} from './library-relocate.test-helpers.ts';

interface RelocateResult {
  ok: boolean;
  outcome?: string;
}

async function resultsOf(res: Response): Promise<RelocateResult[]> {
  return ((await res.json()) as { results: RelocateResult[] }).results;
}

async function isCaseInsensitive(dir: string): Promise<boolean> {
  const probe = path.join(dir, 'CaseProbe');
  await fs.writeFile(probe, '');
  const insensitive = await fs
    .stat(path.join(dir, 'caseprobe'))
    .then(() => true)
    .catch(() => false);
  await fs.rm(probe);
  return insensitive;
}

describe('library-relocate — destination is the source itself (#4701)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
    clearLibraryCache();
  });

  it('a target folder that is a symlink to the source folder keeps the only original', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-symlink-alias-')));
    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, '2024', 'Loose'), { recursive: true });
    await fs.mkdir(path.join(dir, '2024', 'California'), { recursive: true });
    await fs.symlink(
      path.join(dir, '2024', 'Loose'),
      path.join(dir, '2024', 'California', 'Berkeley'),
    );
    await fs.writeFile(path.join(dir, oldRel, 'IMG_7.dng'), 'the-only-copy');

    const asset = seedRelocatableAsset(live.db, {
      root: dir,
      relPath: oldRel,
      filename: 'IMG_7.dng',
      mapleId: 'relocate-symlink-alias-id',
      metadataOverride: usPlaceText(),
    });

    const res = await postRelocate([`${SLUG}:${oldRel}/IMG_7.dng`]);
    expect(res.status).toBe(200);
    const [result] = await resultsOf(res);
    expect(result!.outcome).not.toBe('moved');

    expect(await fs.readFile(path.join(dir, oldRel, 'IMG_7.dng'), 'utf8')).toBe('the-only-copy');
    expect(locationOf(live.db, asset.assetId)).toMatchObject({
      path: oldRel,
      filename: 'IMG_7.dng',
    });
  });

  it('a case-alias target folder keeps the only original on a case-insensitive volume', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-case-alias-')));
    if (!(await isCaseInsensitive(dir))) {
      // On a case-sensitive volume the alias is a distinct folder, so there is
      // nothing to alias; the symlink case above covers the same code path.
      return;
    }
    const oldRel = '2024/california/berkeley';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_8.dng'), 'the-only-copy');

    const asset = seedRelocatableAsset(live.db, {
      root: dir,
      relPath: oldRel,
      filename: 'IMG_8.dng',
      mapleId: 'relocate-case-alias-id',
      metadataOverride: usPlaceText(),
    });

    const res = await postRelocate([`${SLUG}:${oldRel}/IMG_8.dng`]);
    expect(res.status).toBe(200);
    await resultsOf(res);

    expect(await fs.readFile(path.join(dir, oldRel, 'IMG_8.dng'), 'utf8')).toBe('the-only-copy');
    const location = locationOf(live.db, asset.assetId);
    expect(location?.filename).toBe('IMG_8.dng');
    expect(location?.path.toLowerCase()).toBe(oldRel);
  });
});
