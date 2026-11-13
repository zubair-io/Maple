/**
 * End-to-end collision tests for the Live Photo clip of POST /api/library/relocate
 * — #5543, part of #5448.
 *
 * A still and its clip only stay a pair while they share a stem, so when the
 * destination already holds one of the two names both halves move under the same
 * suffixed stem, sidecars included, instead of each resolving its own collision.
 */

import { describe, it, expect, afterEach } from 'bun:test';
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

const OLD_REL = '2024/Loose';
const BERKELEY_REL = '2024/California/Berkeley';

describe('library-relocate end-to-end — Live Photo name collisions (#5543)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
    clearLibraryCache();
  });

  async function stageCollision(occupiedAtDestination: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-live-collide-'));
    dir = root;
    await fs.mkdir(path.join(root, ...OLD_REL.split('/')), { recursive: true });
    await fs.mkdir(path.join(root, ...BERKELEY_REL.split('/')), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(root, OLD_REL, 'IMG_12.HEIC'), 'still-pixels'),
      fs.writeFile(path.join(root, OLD_REL, 'IMG_12.xmp'), 'still-edits'),
      fs.writeFile(path.join(root, OLD_REL, 'IMG_12.MOV'), 'clip-frames'),
      fs.writeFile(path.join(root, OLD_REL, 'IMG_12.MOV.xmp'), 'clip-edits'),
      fs.writeFile(path.join(root, BERKELEY_REL, occupiedAtDestination), 'someone-else'),
    ]);
    return root;
  }

  async function relocatePair(root: string, db: Parameters<typeof seedRelocatableAsset>[0]) {
    const still = seedRelocatableAsset(db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_12.HEIC',
      mapleId: 'live-collide-still',
      metadataOverride: usPlaceText(),
      liveContentId: 'LIVE-PAIR-12',
    });
    const clip = seedRelocatableAsset(db, {
      root,
      relPath: OLD_REL,
      filename: 'IMG_12.MOV',
      mapleId: 'live-collide-clip',
      libraryId: still.libraryId,
      liveContentId: 'LIVE-PAIR-12',
    });
    const res = await postRelocate([`${SLUG}:${OLD_REL}/IMG_12.HEIC`]);
    expect(res.status).toBe(200);
    return { still, clip };
  }

  it.each(['IMG_12.MOV', 'IMG_12.HEIC'])(
    'moves both halves under one suffixed stem when only %s is taken at the destination',
    async (occupied) => {
      using live = await createLiveTestDatabase();
      const root = await stageCollision(occupied);

      const { still, clip } = await relocatePair(root, live.db);

      expect(locationOf(live.db, still.assetId)).toMatchObject({
        path: BERKELEY_REL,
        filename: 'IMG_12.1.HEIC',
      });
      expect(locationOf(live.db, clip.assetId)).toMatchObject({
        path: BERKELEY_REL,
        filename: 'IMG_12.1.MOV',
      });
      const moved = async (name: string) =>
        fs.readFile(path.join(root, BERKELEY_REL, name), 'utf8');
      expect(await moved('IMG_12.1.HEIC')).toBe('still-pixels');
      expect(await moved('IMG_12.1.xmp')).toBe('still-edits');
      expect(await moved('IMG_12.1.MOV')).toBe('clip-frames');
      expect(await moved('IMG_12.1.MOV.xmp')).toBe('clip-edits');
      expect(await moved(occupied)).toBe('someone-else');
    },
  );
});
