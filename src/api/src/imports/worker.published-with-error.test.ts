/**
 * An import publish that takes effect but reports an error (#5937): the link put
 * the image at its name and the copy step still failed, either because the
 * temp file could not be removed and the file could not be withdrawn, or
 * because a network share's link returned an error after it took effect. The
 * image is recorded failed and its marker is cleared, so a retry finds a file
 * with the source's bytes and no marker and treats it as another writer's
 * copy. Real temp directories, real files, and a private SQLite database.
 */

import { expect, spyOn, test } from 'bun:test';
import path from 'node:path';
import fs, * as mirrored from '../fs/mirrored.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { recordedAttempt } from '../temporal/recorded-attempt.test-helpers.ts';
import * as repo from './repo.ts';
import { retryImport } from './retry.ts';
import {
  attemptThatFinishes,
  dests,
  DIR,
  earlierAttemptMarked,
  IMAGE_WITH_SIDECAR,
  marked,
  observedRunner,
  pendingImport,
  place,
  states,
  useImportScratch,
} from './worker-resume.test-helpers.ts';

useImportScratch();

const TEMP_FILE = '.import.tmp.';
const RUNS_AS_ROOT = process.getuid?.() === 0;

const landedNamesWithoutTemps = async (imp: { landedNames: () => Promise<string[]> }) =>
  (await imp.landedNames()).filter((name) => !name.includes(TEMP_FILE));

/**
 * Makes the next link in the library put the file at its name, as the real link
 * does, and then fail: with the folder made read-only, so the temp file cannot
 * be removed and the file cannot be moved aside to withdraw it, or with the
 * error a share reports after the link took effect.
 */
function nextLinkLandsThenFails(failure: { lockFolder: string } | { error: Error }) {
  return spyOn(mirrored, 'link').mockImplementationOnce(async (existing, created) => {
    await fs.link(existing, created);
    if ('error' in failure) throw failure.error;
    await fs.chmod(failure.lockFolder, 0o555);
  });
}

async function runWithNextLinkFailing(
  importId: string,
  failure: Parameters<typeof nextLinkLandsThenFails>[0],
  identity: string,
) {
  const linking = nextLinkLandsThenFails(failure);
  const attempt = observedRunner();
  try {
    const run = await attempt.runner.run(importId, recordedAttempt(identity));
    return { run, attempt };
  } finally {
    linking.mockRestore();
    if ('lockFolder' in failure) await fs.chmod(failure.lockFolder, 0o755);
  }
}

const TRIGGERS = [
  { sub: 'landed-then-failed-unwithdrawn', trigger: 'the file cannot be withdrawn', locks: true },
  { sub: 'landed-then-failed-link-error', trigger: 'the link reports an error', locks: false },
];

for (const { sub, trigger, locks } of TRIGGERS) {
  test.skipIf(locks && RUNS_AS_ROOT)(
    `a publish that lands but fails (${trigger}) is recorded failed with no marker, and a retry skips the image and its sidecar as duplicates`,
    async () => {
      using live = await createLiveTestDatabase();
      const imp = await pendingImport(live.db, sub, IMAGE_WITH_SIDECAR);
      const folder = path.dirname(imp.landed('IMG.dng'));
      await fs.mkdir(folder, { recursive: true });

      const first = await runWithNextLinkFailing(
        imp.importId,
        locks ? { lockFolder: folder } : { error: new Error('EIO: the share reported an error') },
        'first',
      );

      expect(first.run.outcome).toBe('failed');
      expect(await states(imp.id)).toEqual(['failed', 'failed']);
      expect(await marked(imp.id)).toEqual([]);
      expect(await landedNamesWithoutTemps(imp)).toEqual(['IMG.dng']);
      expect(await fs.readFile(imp.landed('IMG.dng'), 'utf8')).toBe(imp.bytes('IMG.dng'));

      expect(await retryImport(imp.id)).toBe(true);
      const second = await attemptThatFinishes(imp.importId);

      expect(await landedNamesWithoutTemps(imp)).toEqual(['IMG.dng']);
      expect(await states(imp.id)).toEqual(['skipped_duplicate', 'skipped_duplicate']);
      expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 0, skipped: 2, failed: 0 });
      expect(second.handed).toEqual([]);
      expect(second.rearmed).toEqual([]);
    },
  );
}

test.skipIf(RUNS_AS_ROOT)(
  'with an earlier attempt marked on another name, a retry after a landed-but-failed publish makes a second copy with its sidecar and leaves the first without one',
  async () => {
    using live = await createLiveTestDatabase();
    const imp = await pendingImport(live.db, 'landed-then-failed-earlier', IMAGE_WITH_SIDECAR);
    await place(imp.landed('IMG.dng'), 'a different photo with the same name');
    await earlierAttemptMarked(imp.id, 1, 'IMG-2.dng');
    const folder = path.dirname(imp.landed('IMG.dng'));

    const second = await runWithNextLinkFailing(imp.importId, { lockFolder: folder }, 'second');

    expect(second.run.outcome).toBe('failed');
    expect(await landedNamesWithoutTemps(imp)).toEqual(['IMG-1.dng', 'IMG.dng']);
    expect(await marked(imp.id)).toEqual([[1, `${DIR}/IMG-2.dng`]]);

    expect(await retryImport(imp.id)).toBe(true);
    const third = await attemptThatFinishes(imp.importId, {}, 'third');

    expect(await landedNamesWithoutTemps(imp)).toEqual([
      'IMG-1.dng',
      'IMG-2.dng',
      'IMG-2.xmp',
      'IMG.dng',
    ]);
    expect(await fs.readFile(imp.landed('IMG-1.dng'), 'utf8')).toBe(imp.bytes('IMG.dng'));
    expect(await fs.readFile(imp.landed('IMG-2.dng'), 'utf8')).toBe(imp.bytes('IMG.dng'));
    expect(await fs.readFile(imp.landed('IMG-2.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
    expect(await dests(imp.id)).toEqual([`${DIR}/IMG-2.xmp`, `${DIR}/IMG-2.dng`]);
    expect(await states(imp.id)).toEqual(['copied', 'copied']);
    expect(await marked(imp.id)).toEqual([]);
    expect(third.handed).toEqual([imp.landed('IMG-2.dng')]);
  },
);
