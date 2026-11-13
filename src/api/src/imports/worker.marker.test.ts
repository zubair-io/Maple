/**
 * ImportRunner and the publish marker where it is easiest to get wrong: an
 * earlier attempt that is still running, images whose names meet after a
 * rename, and a marker whose file is elsewhere, unreadable, or on a row an
 * earlier run had skipped. Real temp dirs, real file copies, and a private
 * SQLite database per test.
 */

import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { recordedAttempt } from '../temporal/recorded-attempt.test-helpers.ts';
import * as repo from './repo.ts';
import { retryImport } from './retry.ts';
import {
  attemptKilledAfter,
  attemptThatFinishes,
  dests,
  DIR,
  earlierAttemptMarked,
  exists,
  HASH,
  IMAGE_WITH_SIDECAR,
  marked,
  observedRunner,
  pendingImport,
  place,
  states,
  useImportScratch,
} from './worker-resume.test-helpers.ts';

useImportScratch();

for (const catalogued of [false, true]) {
  test(`an earlier attempt that lands the image while this one is hashing keeps its sidecar (catalogued by the sweep: ${catalogued})`, async () => {
    using live = await createLiveTestDatabase();
    const imp = await pendingImport(live.db, `landed-late-${catalogued}`, IMAGE_WITH_SIDECAR);
    await earlierAttemptMarked(imp.id, 1, 'IMG.dng');

    const second = await attemptThatFinishes(imp.importId, {
      deps: {
        hashFileForId: async () => {
          await place(imp.landed('IMG.dng'), imp.bytes('IMG.dng'));
          return HASH;
        },
        assetExistsForHash: async () => catalogued,
      },
    });

    expect(await imp.landedNames()).toEqual(['IMG.dng', 'IMG.xmp']);
    expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
    expect(await states(imp.id)).toEqual(['copied', 'copied']);
    expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
    expect(second.handed).toEqual([imp.landed('IMG.dng')]);
    expect(second.rearmed).toEqual(['IMG.dng']);
  });
}

test('an earlier attempt that lands its renamed image while this one is hashing is not copied a second time', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'landed-late-renamed', IMAGE_WITH_SIDECAR);
  await place(imp.landed('IMG.dng'), 'a different photo with the same name');
  await earlierAttemptMarked(imp.id, 1, 'IMG-1.dng');

  const second = await attemptThatFinishes(imp.importId, {
    deps: {
      hashFileForId: async () => {
        await place(imp.landed('IMG-1.dng'), imp.bytes('IMG.dng'));
        return HASH;
      },
    },
  });

  expect(await imp.landedNames()).toEqual(['IMG-1.dng', 'IMG-1.xmp', 'IMG.dng']);
  expect(await fs.readFile(imp.landed('IMG-1.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await dests(imp.id)).toEqual([`${DIR}/IMG-1.xmp`, `${DIR}/IMG-1.dng`]);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([imp.landed('IMG-1.dng')]);
});

test('two images whose names meet after a rename each keep their own sidecar across a stop', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'names-meet', [
    ['IMG.xmp', 'sidecar'],
    ['IMG.dng', 'image'],
    ['IMG-1.xmp', 'sidecar'],
    ['IMG-1.dng', 'image'],
  ]);
  await place(imp.landed('IMG.dng'), 'a different photo with the same name');
  await attemptKilledAfter(2, imp.importId);
  expect(await imp.landedNames()).toEqual(['IMG-1.dng', 'IMG-1.xmp', 'IMG.dng']);
  expect(await states(imp.id)).toEqual(['pending', 'copied', 'pending', 'pending']);

  const second = await attemptThatFinishes(imp.importId);

  expect(await imp.landedNames()).toEqual([
    'IMG-1-1.dng',
    'IMG-1-1.xmp',
    'IMG-1.dng',
    'IMG-1.xmp',
    'IMG.dng',
  ]);
  expect(await fs.readFile(imp.landed('IMG-1.dng'), 'utf8')).toBe(imp.bytes('IMG.dng'));
  expect(await fs.readFile(imp.landed('IMG-1.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await fs.readFile(imp.landed('IMG-1-1.dng'), 'utf8')).toBe(imp.bytes('IMG-1.dng'));
  expect(await fs.readFile(imp.landed('IMG-1-1.xmp'), 'utf8')).toBe(imp.bytes('IMG-1.xmp'));
  expect(await dests(imp.id)).toEqual([
    `${DIR}/IMG-1.xmp`,
    `${DIR}/IMG-1.dng`,
    `${DIR}/IMG-1-1.xmp`,
    `${DIR}/IMG-1-1.dng`,
  ]);
  const after = (await repo.getImport(imp.id))!;
  expect(after.counts).toEqual({ copied: 4, skipped: 0, failed: 0 });
  expect(after.progress).toEqual({ current: 4, total: 4 });
  expect(second.handed).toEqual([imp.landed('IMG-1.dng'), imp.landed('IMG-1-1.dng')]);
});

test('a marked image that is not at the marked name but is in the library elsewhere is a duplicate, not copied again', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'moved-since', IMAGE_WITH_SIDECAR);
  await earlierAttemptMarked(imp.id, 1, 'IMG.dng');

  const second = await attemptThatFinishes(imp.importId, {
    deps: { assetExistsForHash: async () => true },
  });

  expect(await exists(imp.landed('IMG.dng'))).toBe(false);
  expect(await exists(imp.landed('IMG.xmp'))).toBe(false);
  expect(await states(imp.id)).toEqual(['skipped_duplicate', 'skipped_duplicate']);
  expect(await marked(imp.id)).toEqual([]);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 0, skipped: 2, failed: 0 });
  expect(second.handed).toEqual([]);
});

test('a marker on an image an earlier run had skipped still means this import published it', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'skipped-then-marked', IMAGE_WITH_SIDECAR);
  live.db.run(`UPDATE import_files SET state = 'skipped_duplicate' WHERE import_id = ?`, [
    imp.importId,
  ]);
  await earlierAttemptMarked(imp.id, 1, 'IMG.dng');
  await place(imp.landed('IMG.dng'), imp.bytes('IMG.dng'));

  const second = await attemptThatFinishes(imp.importId, {
    deps: { assetExistsForHash: async () => true },
  });

  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
});

test('a marked name that cannot be read fails the group and keeps the marker; nothing is copied under another name', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'unreadable', IMAGE_WITH_SIDECAR);
  await earlierAttemptMarked(imp.id, 1, 'IMG.dng');
  await place(imp.landed('IMG.dng'), imp.bytes('IMG.dng'));
  await fs.chmod(imp.landed('IMG.dng'), 0o000);

  const blocked = observedRunner();
  const run = await blocked.runner.run(imp.importId, recordedAttempt('second'));
  await fs.chmod(imp.landed('IMG.dng'), 0o644);

  expect(run.outcome).toBe('failed');
  expect(await imp.landedNames()).toEqual(['IMG.dng']);
  expect(await states(imp.id)).toEqual(['failed', 'failed']);
  expect(await marked(imp.id)).toEqual([[1, `${DIR}/IMG.dng`]]);
  expect(blocked.handed).toEqual([]);

  expect(await retryImport(imp.id)).toBe(true);
  const third = await attemptThatFinishes(imp.importId, {}, 'third');

  expect(await imp.landedNames()).toEqual(['IMG.dng', 'IMG.xmp']);
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect(await marked(imp.id)).toEqual([]);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(third.handed).toEqual([imp.landed('IMG.dng')]);
});

test('a sidecar recorded failed follows its renamed image, so a retry copies it beside that image and no other', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'failed-follows', IMAGE_WITH_SIDECAR);
  await place(imp.landed('IMG.dng'), 'a different photo with the same name');
  await attemptKilledAfter(1, imp.importId);
  await fs.chmod(imp.landed('IMG-1.dng'), 0o000);
  await attemptKilledAfter(2, imp.importId, 'second');
  await fs.chmod(imp.landed('IMG-1.dng'), 0o644);
  expect(await states(imp.id)).toEqual(['failed', 'pending']);
  expect(await dests(imp.id)).toEqual([`${DIR}/IMG.xmp`, `${DIR}/IMG.dng`]);

  await attemptThatFinishes(imp.importId, {}, 'third');

  expect(await states(imp.id)).toEqual(['failed', 'copied']);
  expect(await dests(imp.id)).toEqual([`${DIR}/IMG-1.xmp`, `${DIR}/IMG-1.dng`]);

  expect(await retryImport(imp.id)).toBe(true);
  const fourth = await attemptThatFinishes(imp.importId, {}, 'fourth');

  expect(await imp.landedNames()).toEqual(['IMG-1.dng', 'IMG-1.xmp', 'IMG.dng']);
  expect(await fs.readFile(imp.landed('IMG-1.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(fourth.handed).toEqual([imp.landed('IMG-1.dng')]);
  expect(fourth.rearmed).toEqual(['IMG-1.dng']);
});

test('a publish that fails clears its marker, so the same photo arriving by another route stays a duplicate on retry', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'failed-publish', IMAGE_WITH_SIDECAR);
  const folder = path.dirname(imp.landed('IMG.dng'));
  await fs.mkdir(folder, { recursive: true });
  await fs.chmod(folder, 0o555);

  const first = observedRunner();
  const run = await first.runner.run(imp.importId, recordedAttempt('first'));
  await fs.chmod(folder, 0o755);

  expect(run.outcome).toBe('failed');
  expect(await states(imp.id)).toEqual(['failed', 'failed']);
  expect(await marked(imp.id)).toEqual([]);
  expect(await imp.landedNames()).toEqual([]);

  await place(imp.landed('IMG.dng'), imp.bytes('IMG.dng'));
  expect(await retryImport(imp.id)).toBe(true);
  const second = await attemptThatFinishes(imp.importId, {
    deps: { assetExistsForHash: async () => true },
  });

  expect(await imp.landedNames()).toEqual(['IMG.dng']);
  expect(await states(imp.id)).toEqual(['skipped_duplicate', 'skipped_duplicate']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 0, skipped: 2, failed: 0 });
  expect(second.handed).toEqual([]);
  expect(second.rearmed).toEqual([]);
});

test('an attempt killed straight after recording a failed image leaves no marker behind', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'failed-then-killed', IMAGE_WITH_SIDECAR);
  const folder = path.dirname(imp.landed('IMG.dng'));
  await fs.mkdir(folder, { recursive: true });
  await fs.chmod(folder, 0o555);

  await attemptKilledAfter(2, imp.importId);
  await fs.chmod(folder, 0o755);

  expect(await states(imp.id)).toEqual(['pending', 'failed']);
  expect(await marked(imp.id)).toEqual([]);
});

test('a failed copy leaves the name an earlier attempt marked, so the copy that attempt then lands still gets its sidecar', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'earlier-still-landing', IMAGE_WITH_SIDECAR);
  await earlierAttemptMarked(imp.id, 1, 'IMG.dng');
  const folder = path.dirname(imp.landed('IMG.dng'));
  await fs.mkdir(folder, { recursive: true });
  await fs.chmod(folder, 0o555);

  const second = observedRunner();
  const run = await second.runner.run(imp.importId, recordedAttempt('second'));
  await fs.chmod(folder, 0o755);

  expect(run.outcome).toBe('failed');
  expect(await states(imp.id)).toEqual(['failed', 'failed']);
  expect(await marked(imp.id)).toEqual([[1, `${DIR}/IMG.dng`]]);

  await place(imp.landed('IMG.dng'), imp.bytes('IMG.dng'));
  expect(await retryImport(imp.id)).toBe(true);
  const third = await attemptThatFinishes(imp.importId, {}, 'third');

  expect(await imp.landedNames()).toEqual(['IMG.dng', 'IMG.xmp']);
  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect(await marked(imp.id)).toEqual([]);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(third.handed).toEqual([imp.landed('IMG.dng')]);
});

test('a failed copy under a sibling name puts back the name the earlier attempt marked', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'sibling-then-earlier', IMAGE_WITH_SIDECAR);
  await earlierAttemptMarked(imp.id, 1, 'IMG.dng');
  await place(imp.landed('IMG.dng'), 'the earlier attempt has written this much');
  const folder = path.dirname(imp.landed('IMG.dng'));
  await fs.chmod(folder, 0o555);

  const second = observedRunner();
  const run = await second.runner.run(imp.importId, recordedAttempt('second'));
  await fs.chmod(folder, 0o755);

  expect(run.outcome).toBe('failed');
  expect(await imp.landedNames()).toEqual(['IMG.dng']);
  expect(await marked(imp.id)).toEqual([[1, `${DIR}/IMG.dng`]]);

  await fs.writeFile(imp.landed('IMG.dng'), imp.bytes('IMG.dng'));
  expect(await retryImport(imp.id)).toBe(true);
  const third = await attemptThatFinishes(imp.importId, {}, 'third');

  expect(await imp.landedNames()).toEqual(['IMG.dng', 'IMG.xmp']);
  expect(await dests(imp.id)).toEqual([`${DIR}/IMG.xmp`, `${DIR}/IMG.dng`]);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(third.handed).toEqual([imp.landed('IMG.dng')]);
});

test('a sidecar that cannot be read where an earlier attempt left it fails that one file, and the import goes on', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'unreadable-sidecar', [
    ['IMG.xmp', 'sidecar'],
    ['IMG.dng', 'image'],
    ['B.dng', 'image'],
  ]);
  await earlierAttemptMarked(imp.id, 1, 'IMG.dng');
  await place(imp.landed('IMG.dng'), imp.bytes('IMG.dng'));
  await place(imp.landed('IMG.xmp'), imp.bytes('IMG.xmp'));
  await fs.chmod(imp.landed('IMG.xmp'), 0o000);

  const second = await attemptThatFinishes(imp.importId);
  await fs.chmod(imp.landed('IMG.xmp'), 0o644);

  expect(await states(imp.id)).toEqual(['failed', 'copied', 'copied']);
  expect(await imp.landedNames()).toEqual(['B.dng', 'IMG.dng', 'IMG.xmp']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 1 });
  expect(second.handed).toEqual([imp.landed('IMG.dng'), imp.landed('B.dng')]);
});
