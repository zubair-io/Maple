/**
 * Old-name backup sidecar helpers (#5021): the route (API process) and the
 * migration (worker process) can both retire the same file, so a removal that
 * finds it already gone is not an error.
 */
import { expect, spyOn, test } from 'bun:test';
import path from 'node:path';
import * as fs from '../fs/mirrored.ts';
import { createTempLibrary } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { removeLegacyIfUnchanged } from './legacy-sidecar.ts';

test('a removal that loses the race to the other process is not an error', async () => {
  using library = await createTempLibrary('maple-legacy-race-');
  const legacy = path.join(library.root, 'IMG.HEIC.xmp');
  await fs.writeFile(legacy, 'old edit');
  const unlink = spyOn(fs, 'unlink').mockImplementationOnce(async () => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  });
  try {
    await expect(removeLegacyIfUnchanged(legacy, Buffer.from('old edit'))).resolves.toBeUndefined();
  } finally {
    unlink.mockRestore();
  }
});
