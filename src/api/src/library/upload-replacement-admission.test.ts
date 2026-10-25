import { expect, spyOn, test } from 'bun:test';
import * as path from 'node:path';
import { replacementFixture } from './upload-replacement.test-helpers';
import { discardIdenticalReplacement } from './upload-replacement';
import { ObjectId } from '../db/object-id';
import { readFile, stat, writeFile } from '../fs/mirrored';
import * as xmpConflict from '../fs/xmp-conflict';
import * as lifecycle from '../cloud-backup/lifecycle';

test.each(['refuses', 'throws', 'preserves a newer destination edit'] as const)(
  'purge admission that %s keeps late edits attached to the Trash photo',
  async (failure) => {
    const f = await replacementFixture();
    const source = path.join(f.library, '.maple/trash/photo.dng');
    const late = path.join(f.library, '.maple/trash/photo.xmp');
    const copy = path.join(f.library, 'photo (conflict from move).xmp');
    try {
      expect((await f.upload('different')).status).toBe(201);
      await writeFile(f.original, 'old-original');
      const realList = xmpConflict.listPairedSidecarsStrict;
      let first = true;
      const listing = spyOn(xmpConflict, 'listPairedSidecarsStrict').mockImplementation(
        async (photo) => {
          const files = await realList(photo);
          if (photo === source && first) {
            first = false;
            await writeFile(late, 'late edit');
          }
          return files;
        },
      );
      const admission = spyOn(lifecycle, 'prepareIdenticalReplacementPurge').mockImplementation(
        async () => {
          // Preflight copied the edit but did not detach it from its current photo.
          expect(await readFile(late, 'utf8')).toBe('late edit');
          expect(await readFile(copy, 'utf8')).toBe('late edit');
          if (failure === 'preserves a newer destination edit') await writeFile(copy, 'newer edit');
          if (failure === 'throws') throw new Error('admission unavailable');
          return false;
        },
      );
      try {
        const purging = discardIdenticalReplacement(
          new ObjectId(f.id),
          f.library,
          source,
          f.original,
        );
        if (failure === 'throws') await expect(purging).rejects.toThrow('admission unavailable');
        else expect(await purging).toBe(false);
      } finally {
        listing.mockRestore();
        admission.mockRestore();
      }
      expect(await readFile(source, 'utf8')).toBe('old-original');
      expect(await readFile(late, 'utf8')).toBe('late edit');
      if (failure === 'preserves a newer destination edit')
        expect(await readFile(copy, 'utf8')).toBe('newer edit');
      else await expect(stat(copy)).rejects.toThrow();
      expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.id)).not.toBeNull();
    } finally {
      await f.close();
    }
  },
);

test('an admitted purge retires the staged source only after its edit is durable beside the replacement', async () => {
  const f = await replacementFixture();
  const source = path.join(f.library, '.maple/trash/photo.dng');
  const late = path.join(f.library, '.maple/trash/photo.xmp');
  try {
    expect((await f.upload('different')).status).toBe(201);
    await writeFile(f.original, 'old-original');
    const realList = xmpConflict.listPairedSidecarsStrict;
    let first = true;
    const listing = spyOn(xmpConflict, 'listPairedSidecarsStrict').mockImplementation(
      async (photo) => {
        const files = await realList(photo);
        if (photo === source && first) {
          first = false;
          await writeFile(late, 'late edit');
        }
        return files;
      },
    );
    try {
      expect(
        await discardIdenticalReplacement(new ObjectId(f.id), f.library, source, f.original),
      ).toBe(true);
    } finally {
      listing.mockRestore();
    }
    await expect(stat(source)).rejects.toThrow();
    await expect(stat(late)).rejects.toThrow();
    expect(await readFile(path.join(f.library, 'photo (conflict from move).xmp'), 'utf8')).toBe(
      'late edit',
    );
    expect(await xmpConflict.listPairedSidecarsStrict(f.original)).toEqual([
      path.join(f.library, 'photo (conflict from move).xmp'),
    ]);
    expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.id)).toBeNull();
  } finally {
    await f.close();
  }
});
