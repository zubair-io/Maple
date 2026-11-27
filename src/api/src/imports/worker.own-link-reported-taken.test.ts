/**
 * A link that took effect and was reported as "name taken" (#5937): on a share
 * that retries a link whose reply was lost, the retry meets the file the first
 * one made and answers `EEXIST`. The file at the name is then this attempt's
 * own, and the image must finish as copied; a different file with the same
 * bytes is another writer's and stays a duplicate. Real temp directories, real
 * files, and a private SQLite database.
 */

import { expect, spyOn, test } from 'bun:test';
import fs, * as mirrored from '../fs/mirrored.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import * as repo from './repo.ts';
import {
  attemptThatFinishes,
  IMAGE_WITH_SIDECAR,
  marked,
  pendingImport,
  place,
  states,
  useImportScratch,
} from './worker-resume.test-helpers.ts';

useImportScratch();

const reportedTaken = () =>
  Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });

test("a link reported as name taken after it took effect does not make the attempt skip its own image's sidecar", async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'own-link-reported-taken', IMAGE_WITH_SIDECAR);
  const linking = spyOn(mirrored, 'link').mockImplementationOnce(async (existing, created) => {
    await fs.link(existing, created);
    throw reportedTaken();
  });
  const attempt = await attemptThatFinishes(imp.importId).finally(() => linking.mockRestore());

  expect(await imp.landedNames()).toEqual(['IMG.dng', 'IMG.xmp']);
  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect(await marked(imp.id)).toEqual([]);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(attempt.handed).toEqual([imp.landed('IMG.dng')]);
});

test("another writer's file with the same bytes at the name is still a duplicate, with its sidecar skipped", async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'other-writers-identical-copy', IMAGE_WITH_SIDECAR);
  const linking = spyOn(mirrored, 'link').mockImplementationOnce(async () => {
    await place(imp.landed('IMG.dng'), imp.bytes('IMG.dng'));
    throw reportedTaken();
  });
  const attempt = await attemptThatFinishes(imp.importId).finally(() => linking.mockRestore());

  expect(await imp.landedNames()).toEqual(['IMG.dng']);
  expect(await states(imp.id)).toEqual(['skipped_duplicate', 'skipped_duplicate']);
  expect(await marked(imp.id)).toEqual([]);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 0, skipped: 2, failed: 0 });
  expect(attempt.handed).toEqual([]);
});
