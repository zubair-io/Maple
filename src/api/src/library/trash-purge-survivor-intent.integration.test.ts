/**
 * #5419: a whole-photo purge recorded by an earlier attempt, when the photo
 * turns out to have a surviving copy, no longer completes as a full purge.
 * The photo stays, the earlier record is retired, and the surviving copy's
 * backups stay unless their erasure had already started. Real library and
 * mirror files, one real SQLite database, the real purge drain, and Google
 * Drive behind the fake Drive transport.
 */

import { expect, test } from 'bun:test';
import * as path from 'node:path';
import { chmod, readFile, rm, stat } from '../fs/mirrored.ts';
import { ObjectId } from '../db/object-id.ts';
import { drainPurges } from '../cloud-backup/purge.ts';
import { backupEngine } from '../cloud-backup/runtime.ts';
import { hardDeleteAdmittedPurge } from '../db/repos/assets.trash.ts';
import { runTrashGcOnce } from '../workers/trash-gc.ts';
import { COMPANION, OLD, RAW, twoCopyPhoto } from './trash-purge-survivor-intent.test-helpers.ts';

const gone = (target: string) =>
  stat(target).then(
    () => false,
    () => true,
  );

type Photo = Awaited<ReturnType<typeof twoCopyPhoto>>;

function photoRow(f: Photo) {
  return f.live.db
    .query(`SELECT deleted_at, rating, apple_rendered_path FROM assets WHERE id = ?`)
    .get(f.id);
}

function purgeIntents(f: Photo) {
  return f.live.db.query(`SELECT COUNT(*) AS n FROM backup_lifecycle WHERE kind = 'purge'`).get();
}

function entryOf(f: Photo, entryId: string) {
  return f.live.db.query(`SELECT ordinal, state FROM backup_entries WHERE id = ?`).get(entryId) as {
    ordinal: number;
    state: string;
  };
}

test.skipIf(process.getuid?.() === 0)(
  'a retry after a failed whole-photo purge keeps the photo and the surviving copy’s mirror backups',
  async () => {
    const f = await twoCopyPhoto('folder');
    const keptDir = path.dirname(f.keptRaw);
    try {
      f.setKeptMissing(true);
      await chmod(keptDir, 0o555);
      const failed = await f.purgeRoute();
      await chmod(keptDir, 0o755);
      expect(failed.status).toBe(500);
      expect(purgeIntents(f)).toEqual({ n: 1 });
      const [keptEntry] = await f.keptEntryIds();
      expect(entryOf(f, keptEntry!).state).toBe('purged');

      f.setKeptMissing(false);
      const res = await f.purgeRoute();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        asset_id: f.id,
        state: 'live',
        abs_path: f.keptRaw,
        cleanup: 'done',
      });
      expect(photoRow(f)).toEqual({ deleted_at: null, rating: 4, apple_rendered_path: COMPANION });
      expect(purgeIntents(f)).toEqual({ n: 0 });
      expect(entryOf(f, keptEntry!)).toEqual({ ordinal: 0, state: 'active' });
      expect(
        f.live.db.query(`SELECT entry_id FROM backup_purges`).all() as Array<{ entry_id: string }>,
      ).not.toContainEqual({ entry_id: keptEntry });
      expect(await gone(f.trashedRaw)).toBe(true);

      await drainPurges(backupEngine, f.destination);

      expect(await gone(f.mirrorOf(f.trashedRaw))).toBe(true);
      expect(await readFile(f.mirrorOf(f.keptRaw), 'utf8')).toBe(RAW);
      expect(await readFile(f.mirrorOf(path.join(f.library, COMPANION)), 'utf8')).toBe(
        'rendered-edit',
      );
      expect(await readFile(f.keptRaw, 'utf8')).toBe(RAW);
      expect(await readFile(path.join(f.library, COMPANION), 'utf8')).toBe('rendered-edit');
    } finally {
      await chmod(keptDir, 0o755).catch(() => {});
      await f.close();
    }
  },
);

test('a recorded whole-photo purge nothing was erased for keeps the surviving copy’s Drive backups', async () => {
  const f = await twoCopyPhoto('google-drive');
  try {
    const [keptEntry] = await f.keptEntryIds();
    const keptKeys = f.remoteObjects(keptEntry!).map((row) => row.key);
    expect(keptKeys.length).toBeGreaterThan(0);
    f.setKeptMissing(true);
    await f.recordWholePhotoPurge();
    f.setKeptMissing(false);

    expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({
      scanned: 1,
      purged: 1,
      errors: 0,
    });
    await drainPurges(f.engine, f.destination);

    expect(photoRow(f)).toEqual({ deleted_at: null, rating: 4, apple_rendered_path: COMPANION });
    expect(entryOf(f, keptEntry!)).toEqual({ ordinal: 0, state: 'active' });
    for (const key of keptKeys) expect(await f.driveHas(key)).toBe(true);
    expect(await f.engine.backupAsset(f.id)).toBe(true);
    expect(await f.keptEntryIds()).toEqual([keptEntry!]);
    expect(await readFile(f.keptRaw, 'utf8')).toBe(RAW);
  } finally {
    await f.close();
  }
});

test('when Drive erasure already finished, the photo is still kept and its copy is backed up again', async () => {
  const f = await twoCopyPhoto('google-drive');
  try {
    const [keptEntry] = await f.keptEntryIds();
    f.setKeptMissing(true);
    await f.recordWholePhotoPurge();
    await drainPurges(f.engine, f.destination);
    expect(
      f.live.db.query(`SELECT COUNT(*) AS n FROM backup_purges WHERE completed = 0`).get(),
    ).toEqual({ n: 0 });
    f.setKeptMissing(false);

    const res = await f.purgeRoute();

    expect(res.status).toBe(200);
    expect(photoRow(f)).toEqual({ deleted_at: null, rating: 4, apple_rendered_path: COMPANION });
    expect(f.live.db.query(`SELECT COUNT(*) AS n FROM assets WHERE id = ?`).get(f.id)).toEqual({
      n: 1,
    });
    expect(purgeIntents(f)).toEqual({ n: 0 });
    const erased = entryOf(f, keptEntry!);
    expect(erased.state).toBe('purged');
    expect(erased.ordinal).toBeGreaterThan(1);

    expect(await f.engine.backupAsset(f.id)).toBe(true);
    const [fresh] = (await f.keptEntryIds()).filter((entryId) => entryId !== keptEntry);
    expect(entryOf(f, fresh!)).toEqual({ ordinal: 0, state: 'active' });
    for (const { key } of f.remoteObjects(fresh!)) expect(await f.driveHas(key)).toBe(true);
    expect(await readFile(f.keptRaw, 'utf8')).toBe(RAW);
  } finally {
    await f.close();
  }
});

test('an erasure already under way finishes, then frees the copy to be backed up again', async () => {
  const f = await twoCopyPhoto('google-drive');
  try {
    const [keptEntry] = await f.keptEntryIds();
    f.setKeptMissing(true);
    await f.recordWholePhotoPurge();
    f.failDriveRemovals(true);
    await drainPurges(f.engine, f.destination);
    f.failDriveRemovals(false);
    f.setKeptMissing(false);

    expect((await f.purgeRoute()).status).toBe(200);
    expect(photoRow(f)).toEqual({ deleted_at: null, rating: 4, apple_rendered_path: COMPANION });
    expect(entryOf(f, keptEntry!)).toEqual({ ordinal: 0, state: 'purged' });
    expect(
      f.live.db.query(`SELECT completed FROM backup_purges WHERE entry_id = ?`).get(keptEntry!),
    ).toEqual({ completed: 0 });

    run(f, `UPDATE stage_state SET version = 1 WHERE asset_id = ? AND stage = 'cloud-backup'`);
    await drainPurges(f.engine, f.destination);

    expect(entryOf(f, keptEntry!).ordinal).toBeGreaterThan(1);
    expect(
      f.live.db
        .query(`SELECT version FROM stage_state WHERE asset_id = ? AND stage = 'cloud-backup'`)
        .get(f.id),
    ).toEqual({ version: 0 });
    expect(await f.engine.backupAsset(f.id)).toBe(true);
    const [fresh] = (await f.keptEntryIds()).filter((entryId) => entryId !== keptEntry);
    expect(entryOf(f, fresh!)).toEqual({ ordinal: 0, state: 'active' });
  } finally {
    await f.close();
  }
});

test('a full purge still running holds its record, so no other attempt keeps the photo under it', async () => {
  const f = await twoCopyPhoto('google-drive');
  try {
    f.setKeptMissing(true);
    await f.recordWholePhotoPurge({ stopped: false });
    f.setKeptMissing(false);

    expect((await f.purgeRoute()).status).toBe(409);
    expect(purgeIntents(f)).toEqual({ n: 1 });
    expect(photoRow(f)).toEqual({ deleted_at: OLD, rating: 4, apple_rendered_path: COMPANION });
  } finally {
    await f.close();
  }
});

test('companions an abandoned whole-photo purge already erased are cleared from the kept photo', async () => {
  const f = await twoCopyPhoto('google-drive');
  try {
    f.setKeptMissing(true);
    await f.recordWholePhotoPurge();
    await rm(path.join(f.library, COMPANION));
    f.setKeptMissing(false);

    expect((await f.purgeRoute()).status).toBe(200);

    expect(photoRow(f)).toEqual({ deleted_at: null, rating: 4, apple_rendered_path: null });
    expect(await f.engine.backupAsset(f.id)).toBe(true);
    expect(await readFile(f.keptRaw, 'utf8')).toBe(RAW);
  } finally {
    await f.close();
  }
});

test('an attempt still finishing a full purge cannot delete a photo another attempt kept', async () => {
  const f = await twoCopyPhoto('google-drive');
  try {
    f.setKeptMissing(true);
    await f.recordWholePhotoPurge();
    f.setKeptMissing(false);
    expect((await f.purgeRoute()).status).toBe(200);

    expect((await hardDeleteAdmittedPurge(new ObjectId(f.id))).deletedCount).toBe(0);
    expect(photoRow(f)).toEqual({ deleted_at: null, rating: 4, apple_rendered_path: COMPANION });
  } finally {
    await f.close();
  }
});

function run(f: Photo, sql: string) {
  f.live.db.query(sql).run(f.id);
}
