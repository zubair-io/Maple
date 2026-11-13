/**
 * ImportRunner when an earlier attempt of the same import stopped partway
 * through a group (#5928, #5932): the next attempt finishes the group that
 * attempt had marked instead of skipping its sidecars, and judges every group
 * it had not started afresh. Real temp dirs, real file copies, and a private
 * SQLite database per test.
 */

import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import { ObjectId } from '../db/object-id.ts';
import { createLiveTestDatabase, insertFolder } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { recordedAttempt } from '../temporal/recorded-attempt.test-helpers.ts';
import * as repo from './repo.ts';
import { retryImport } from './retry.ts';
import {
  attemptKilledAfter,
  attemptThatFinishes,
  clockDoingAtWrite,
  dests,
  DIR,
  earlierAttemptMarked,
  exists,
  handOffTheWorkerDiesIn,
  HASH,
  IMAGE_WITH_SIDECAR,
  marked,
  observedRunner,
  pendingImport,
  place,
  scratchPath,
  states,
  useImportScratch,
} from './worker-resume.test-helpers.ts';

useImportScratch();

test('an attempt killed between copying an image and recording it leaves the sidecar to the next attempt', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'killed', IMAGE_WITH_SIDECAR);
  const first = await attemptKilledAfter(1, imp.importId);

  expect(await fs.readFile(imp.landed('IMG.dng'), 'utf8')).toBe(imp.bytes('IMG.dng'));
  expect(await exists(imp.landed('IMG.xmp'))).toBe(false);
  expect(await states(imp.id)).toEqual(['pending', 'pending']);
  expect((await repo.getImport(imp.id))!.status).toBe('running');
  expect(await marked(imp.id)).toEqual([[1, `${DIR}/IMG.dng`]]);
  expect(first.handed).toEqual([]);

  const second = await attemptThatFinishes(imp.importId);

  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect(await marked(imp.id)).toEqual([]);
  const after = (await repo.getImport(imp.id))!;
  expect(after.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(after.progress).toEqual({ current: 2, total: 2 });
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
  expect(second.rearmed).toEqual(['IMG.dng']);
});

test('the sidecar still follows when the sweep catalogued the unrecorded image before the next attempt', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'catalogued', IMAGE_WITH_SIDECAR);
  await attemptKilledAfter(1, imp.importId);

  const second = await attemptThatFinishes(imp.importId, {
    deps: { assetExistsForHash: async () => true },
  });

  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
  expect(second.rearmed).toEqual(['IMG.dng']);
});

test('an attempt replaced before it publishes an image is refused its marker and publishes nothing', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'replaced-early', IMAGE_WITH_SIDECAR);
  const first = observedRunner({
    deps: {
      hashFileForId: async () => {
        await repo.claimImport(imp.id, 'second');
        return HASH;
      },
    },
  });

  await expect(first.runner.run(imp.importId, recordedAttempt('first'))).rejects.toBeInstanceOf(
    repo.ImportTakenOver,
  );
  expect(await exists(imp.landed('IMG.dng'))).toBe(false);
  expect(await marked(imp.id)).toEqual([]);

  const second = await attemptThatFinishes(imp.importId);

  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
});

test('an attempt replaced after copying an image has its record refused, and the replacement copies the sidecar', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'replaced', IMAGE_WITH_SIDECAR);
  const replacedAtItsFirstRecord = clockDoingAtWrite(2, () => {
    live.db.run(`UPDATE imports SET locked_by = 'second' WHERE id = ?`, [imp.importId]);
  });
  const first = observedRunner({ now: replacedAtItsFirstRecord });

  await expect(first.runner.run(imp.importId, recordedAttempt('first'))).rejects.toBeInstanceOf(
    repo.ImportTakenOver,
  );
  expect(await exists(imp.landed('IMG.dng'))).toBe(true);
  expect(await states(imp.id)).toEqual(['pending', 'pending']);

  const second = await attemptThatFinishes(imp.importId);

  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
});

test('an image an earlier attempt marked but never landed is copied by the next attempt', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'marked-only', IMAGE_WITH_SIDECAR);
  await earlierAttemptMarked(imp.id, 1, 'IMG.dng');

  const second = await attemptThatFinishes(imp.importId);

  expect(await fs.readFile(imp.landed('IMG.dng'), 'utf8')).toBe(imp.bytes('IMG.dng'));
  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect(await marked(imp.id)).toEqual([]);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
});

test('an attempt killed while copying sidecars still gets its image indexed and re-armed by the next attempt', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'sidecar-stage', [
    ['IMG.xmp', 'sidecar'],
    ['IMG (conflict from Mac).xmp', 'sidecar'],
    ['IMG.dng', 'image'],
  ]);
  const first = await attemptKilledAfter(2, imp.importId);

  expect(await exists(imp.landed('IMG.xmp'))).toBe(true);
  expect(await exists(imp.landed('IMG (conflict from Mac).xmp'))).toBe(false);
  expect(await states(imp.id)).toEqual(['pending', 'pending', 'copied']);
  expect(first.handed).toEqual([]);

  const second = await attemptThatFinishes(imp.importId);

  expect(await fs.readFile(imp.landed('IMG (conflict from Mac).xmp'), 'utf8')).toBe(
    imp.bytes('IMG (conflict from Mac).xmp'),
  );
  expect(await states(imp.id)).toEqual(['copied', 'copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 3, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
  expect(second.rearmed).toEqual(['IMG.dng']);
});

test('the next attempt indexes the image even when every sidecar had landed before the kill', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'sidecar-landed', IMAGE_WITH_SIDECAR);
  await attemptKilledAfter(2, imp.importId);
  expect(await exists(imp.landed('IMG.xmp'))).toBe(true);
  expect(await states(imp.id)).toEqual(['pending', 'copied']);

  const second = await attemptThatFinishes(imp.importId);

  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
  expect(second.rearmed).toEqual(['IMG.dng']);
});

test('a duplicate in a group the earlier attempt never reached is still skipped with its sidecar', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'later-duplicate', [
    ['IMG.xmp', 'sidecar'],
    ['IMG.dng', 'image'],
    ['clip.mov', 'movie'],
    ['clip.mov.xmp', 'sidecar'],
  ]);
  await place(imp.landed('clip.mov'), imp.bytes('clip.mov'));
  await attemptKilledAfter(1, imp.importId);

  await attemptThatFinishes(imp.importId);

  expect(await states(imp.id)).toEqual([
    'copied',
    'copied',
    'skipped_duplicate',
    'skipped_duplicate',
  ]);
  expect(await exists(imp.landed('clip.mov.xmp'))).toBe(false);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 2, failed: 0 });
});

test('a movie the earlier attempt copied but never recorded gets its sidecar, and is not handed to the indexer', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'movie', [
    ['clip.mov', 'movie'],
    ['clip.mov.xmp', 'sidecar'],
  ]);
  await attemptKilledAfter(1, imp.importId);
  expect(await exists(imp.landed('clip.mov'))).toBe(true);
  expect(await exists(imp.landed('clip.mov.xmp'))).toBe(false);

  const second = await attemptThatFinishes(imp.importId);

  expect(await fs.readFile(imp.landed('clip.mov.xmp'), 'utf8')).toBe(imp.bytes('clip.mov.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([]);
});

test('groups finished before the kill keep their outcome and are not handed over again', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'second-group', [
    ['A.dng', 'image'],
    ['B.xmp', 'sidecar'],
    ['B.dng', 'image'],
  ]);
  const first = await attemptKilledAfter(2, imp.importId);
  expect(await states(imp.id)).toEqual(['copied', 'pending', 'pending']);
  expect(await exists(imp.landed('B.dng'))).toBe(true);
  expect(first.handed).toEqual([imp.landed('A.dng')]);

  const second = await attemptThatFinishes(imp.importId);

  expect(await fs.readFile(imp.landed('B.xmp'), 'utf8')).toBe(imp.bytes('B.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied', 'copied']);
  const after = (await repo.getImport(imp.id))!;
  expect(after.counts).toEqual({ copied: 3, skipped: 0, failed: 0 });
  expect(after.progress).toEqual({ current: 3, total: 3 });
  expect(second.handed).toEqual([imp.landed('B.dng')]);
});

test('an Auto Import taken over before its scan finished has copied nothing, so a file already there is a duplicate', async () => {
  using live = await createLiveTestDatabase();
  const source = scratchPath('unscanned', 'src');
  const lib = scratchPath('unscanned', 'lib');
  const captured = new Date('2024-03-09T12:00:00Z');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(`${source}/IMG.dng`, 'unscanned image');
  await fs.writeFile(`${source}/IMG.xmp`, 'unscanned sidecar');
  await fs.utimes(`${source}/IMG.dng`, captured, captured);
  await fs.utimes(`${source}/IMG.xmp`, captured, captured);
  await place(`${lib}/2024/misc/src/IMG.dng`, 'unscanned image');
  const created = await repo.createImport({
    source_root: source,
    library_id: new ObjectId(insertFolder(live.db, { path: lib })),
    library_root: lib,
    files: [],
    scan_pending: true,
  });
  await repo.claimImport(created._id, 'first');

  const second = await attemptThatFinishes(created._id.toHexString());

  expect((await repo.getImportFiles(created._id)).map((file) => file.state).sort()).toEqual([
    'skipped_duplicate',
    'skipped_duplicate',
  ]);
  expect(await exists(`${lib}/2024/misc/src/IMG.xmp`)).toBe(false);
  expect(second.handed).toEqual([]);
});

test('a different sidecar already beside the unrecorded image is left alone, with no renamed copy', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'edited-since', IMAGE_WITH_SIDECAR);
  await earlierAttemptMarked(imp.id, 1, 'IMG.dng');
  await place(imp.landed('IMG.dng'), imp.bytes('IMG.dng'));
  await place(imp.landed('IMG.xmp'), 'edits made in the library');

  const second = await attemptThatFinishes(imp.importId);

  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe('edits made in the library');
  expect(await imp.landedNames()).toEqual(['IMG.dng', 'IMG.xmp']);
  expect(await states(imp.id)).toEqual(['skipped_duplicate', 'copied']);
  expect(await fs.readFile(imp.source('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
});

test('an image that landed under a new name after a collision is recognised, and its sidecar follows that name', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'renamed', IMAGE_WITH_SIDECAR);
  await place(imp.landed('IMG.dng'), 'a different photo with the same name');
  const first = await attemptKilledAfter(1, imp.importId);

  expect(await fs.readFile(imp.landed('IMG-1.dng'), 'utf8')).toBe(imp.bytes('IMG.dng'));
  expect(await imp.landedNames()).toEqual(['IMG-1.dng', 'IMG.dng']);
  expect(await states(imp.id)).toEqual(['pending', 'pending']);
  expect(await marked(imp.id)).toEqual([[1, `${DIR}/IMG-1.dng`]]);
  expect(first.handed).toEqual([]);

  const second = await attemptThatFinishes(imp.importId);

  expect(await imp.landedNames()).toEqual(['IMG-1.dng', 'IMG-1.xmp', 'IMG.dng']);
  expect(await fs.readFile(imp.landed('IMG-1.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await fs.readFile(imp.landed('IMG.dng'), 'utf8')).toBe(
    'a different photo with the same name',
  );
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect(await dests(imp.id)).toEqual([`${DIR}/IMG-1.xmp`, `${DIR}/IMG-1.dng`]);
  expect(await marked(imp.id)).toEqual([]);
  const after = (await repo.getImport(imp.id))!;
  expect(after.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(after.progress).toEqual({ current: 2, total: 2 });
  expect(second.handed).toEqual([imp.landed('IMG-1.dng')]);
  expect(second.rearmed).toEqual(['IMG-1.dng']);
  expect(await fs.readFile(imp.source('IMG.dng'), 'utf8')).toBe(imp.bytes('IMG.dng'));
});

test('an attempt killed while copying the sidecars of a renamed image leaves them all following the new name', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'renamed-sidecars', [
    ['IMG.xmp', 'sidecar'],
    ['IMG (conflict from Mac).xmp', 'sidecar'],
    ['IMG.dng', 'image'],
  ]);
  await place(imp.landed('IMG.dng'), 'a different photo with the same name');
  await attemptKilledAfter(2, imp.importId);

  expect(await imp.landedNames()).toEqual(['IMG-1.dng', 'IMG-1.xmp', 'IMG.dng']);
  expect(await states(imp.id)).toEqual(['pending', 'pending', 'copied']);
  expect(await dests(imp.id)).toEqual([
    `${DIR}/IMG-1.xmp`,
    `${DIR}/IMG-1 (conflict from Mac).xmp`,
    `${DIR}/IMG-1.dng`,
  ]);

  const second = await attemptThatFinishes(imp.importId);

  expect(await imp.landedNames()).toEqual([
    'IMG-1 (conflict from Mac).xmp',
    'IMG-1.dng',
    'IMG-1.xmp',
    'IMG.dng',
  ]);
  expect(await fs.readFile(imp.landed('IMG-1 (conflict from Mac).xmp'), 'utf8')).toBe(
    imp.bytes('IMG (conflict from Mac).xmp'),
  );
  expect(await states(imp.id)).toEqual(['copied', 'copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 3, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([imp.landed('IMG-1.dng')]);
  expect(second.rearmed).toEqual(['IMG-1.dng']);
});

test('an import failed by a record that could not be written can be retried, and the image gets its sidecar', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'record-failed', IMAGE_WITH_SIDECAR);
  const failingItsFirstRecord = clockDoingAtWrite(2, () => {
    throw new Error('database or disk is full');
  });
  const first = observedRunner({ now: failingItsFirstRecord });

  expect(await first.runner.run(imp.importId, recordedAttempt('first'))).toEqual({
    outcome: 'failed',
    error: 'database or disk is full',
  });
  expect(await exists(imp.landed('IMG.dng'))).toBe(true);
  expect(await exists(imp.landed('IMG.xmp'))).toBe(false);
  expect(await states(imp.id)).toEqual(['pending', 'pending']);
  expect((await repo.getImport(imp.id))!.status).toBe('failed');
  expect(first.handed).toEqual([]);

  expect(await retryImport(imp.id)).toBe(true);
  const second = await attemptThatFinishes(imp.importId);

  expect(await imp.landedNames()).toEqual(['IMG.dng', 'IMG.xmp']);
  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  const after = (await repo.getImport(imp.id))!;
  expect(after.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(after.error).toBeNull();
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
  expect(second.rearmed).toEqual(['IMG.dng']);
});

test("an attempt stopped after a group's last record and before the indexer hand-off leaves the hand-off to the next attempt", async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'before-hand-off', IMAGE_WITH_SIDECAR);
  const dying = handOffTheWorkerDiesIn();
  const first = observedRunner({ deps: { handleEvent: dying.handleEvent } });
  first.runner.run(imp.importId, recordedAttempt('first')).catch(() => {});
  await dying.reached;

  expect(await imp.landedNames()).toEqual(['IMG.dng', 'IMG.xmp']);
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect(await marked(imp.id)).toEqual([[1, `${DIR}/IMG.dng`]]);
  expect((await repo.getImport(imp.id))!.status).toBe('running');

  const second = await attemptThatFinishes(imp.importId);

  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
  expect(second.rearmed).toEqual(['IMG.dng']);
  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect(await marked(imp.id)).toEqual([]);
  const after = (await repo.getImport(imp.id))!;
  expect(after.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(after.progress).toEqual({ current: 2, total: 2 });
});

test('a retried sidecar copy stopped before the hand-off is still handed over and re-armed by the next attempt', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'retried-hand-off', IMAGE_WITH_SIDECAR);
  await fs.rm(imp.source('IMG.xmp'));
  await attemptThatFinishes(imp.importId, {}, 'first');
  expect(await states(imp.id)).toEqual(['failed', 'copied']);
  await fs.writeFile(imp.source('IMG.xmp'), imp.bytes('IMG.xmp'));
  expect(await retryImport(imp.id)).toBe(true);

  const dying = handOffTheWorkerDiesIn();
  const second = observedRunner({ deps: { handleEvent: dying.handleEvent } });
  second.runner.run(imp.importId, recordedAttempt('second')).catch(() => {});
  await dying.reached;
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect(await marked(imp.id)).toEqual([[1, `${DIR}/IMG.dng`]]);

  const third = await attemptThatFinishes(imp.importId, {}, 'third');

  expect(third.handed).toEqual([imp.landed('IMG.dng')]);
  expect(third.rearmed).toEqual(['IMG.dng']);
  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await marked(imp.id)).toEqual([]);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
});

test('a group the earlier attempt had not started is judged afresh: an image already in the library stays a duplicate and gains no sidecar', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'between-groups', [
    ['A.dng', 'image'],
    ['B.xmp', 'sidecar'],
    ['B.dng', 'image'],
  ]);
  await place(imp.landed('B.dng'), imp.bytes('B.dng'));
  const first = await attemptKilledAfter(2, imp.importId);

  expect(await states(imp.id)).toEqual(['copied', 'pending', 'pending']);
  expect(await marked(imp.id)).toEqual([]);
  expect(first.handed).toEqual([imp.landed('A.dng')]);

  const second = await attemptThatFinishes(imp.importId);

  expect(await states(imp.id)).toEqual(['copied', 'skipped_duplicate', 'skipped_duplicate']);
  expect(await imp.landedNames()).toEqual(['A.dng', 'B.dng']);
  const after = (await repo.getImport(imp.id))!;
  expect(after.counts).toEqual({ copied: 1, skipped: 2, failed: 0 });
  expect(after.progress).toEqual({ current: 3, total: 3 });
  expect(second.handed).toEqual([]);
  expect(second.rearmed).toEqual([]);
});
