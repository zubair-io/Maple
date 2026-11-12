/**
 * One import, one activity attempt, no Temporal: what `ImportRunner.run` does
 * when its delivery is a repeat, when the import is unknown, and when the
 * engine wants the attempt to stop, and how it keeps the engine informed while
 * it copies. Real temp dirs and a private SQLite database per test.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { AttemptSuperseded, UnknownRowError } from '../temporal/activity-attempt.ts';
import { recordedAttempt } from '../temporal/recorded-attempt.test-helpers.ts';
import { claimImport, createImport, failImport, getImport, ImportTakenOver } from './repo.ts';
import { ImportRunner, type ImportRunnerDeps } from './worker.ts';

let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-import-attempt-'));
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/** A pending import of `names`, each a distinct image staged under `<tmp>/<sub>/src`. */
async function pendingImport(db: Database, sub: string, names: string[]) {
  const source = path.join(tmp, sub, 'src');
  const lib = path.join(tmp, sub, 'lib');
  await fs.mkdir(source, { recursive: true });
  await Promise.all(names.map((name) => fs.writeFile(path.join(source, name), `${sub}-${name}`)));
  const created = await createImport({
    source_root: source,
    library_id: new ObjectId(insertFolder(db, { path: lib })),
    library_root: lib,
    files: names.map((name) => ({
      src: path.join(source, name),
      dest: `2024/03/${name}`,
      size: 1,
      mtime: 0,
      kind: 'image' as const,
      state: 'pending' as const,
      error: null,
    })),
  });
  return { id: created._id, importId: created._id.toHexString(), lib };
}

const runnerWith = (handleEvent: ImportRunnerDeps['handleEvent'], heartbeatEveryMs?: number) =>
  new ImportRunner({
    heartbeatEveryMs,
    deps: { assetExistsForHash: async () => false, handleEvent },
  });

const landed = (lib: string, name: string) =>
  fs.stat(path.join(lib, '2024/03', name)).then(
    () => true,
    () => false,
  );

describe('ImportRunner.run', () => {
  test('a redelivery for a finished import copies nothing and reports how it finished', async () => {
    using live = await createLiveTestDatabase();
    const finished = await pendingImport(live.db, 'redelivered', ['A.dng']);
    const failed = await pendingImport(live.db, 'redelivered-failed', ['B.dng']);
    await failImport(failed.id, 'disk full');
    let handed = 0;
    const runner = runnerWith(async () => {
      handed += 1;
    });

    expect(await runner.run(finished.importId, recordedAttempt('a1'))).toEqual({ outcome: 'done' });
    expect(await runner.run(finished.importId, recordedAttempt('a2'))).toEqual({ outcome: 'done' });
    expect(await runner.run(failed.importId, recordedAttempt('a3'))).toEqual({
      outcome: 'failed',
      error: 'disk full',
    });
    expect(handed).toBe(1);
  });

  test('an import this database has never seen is an error, not a quiet skip', async () => {
    using _live = await createLiveTestDatabase();

    const running = runnerWith(async () => {}).run(
      new ObjectId().toHexString(),
      recordedAttempt('a1'),
    );

    await expect(running).rejects.toBeInstanceOf(UnknownRowError);
    await expect(running).rejects.toThrow('its own Temporal namespace');
  });

  test('an attempt paused or reset in Temporal stops between files and leaves the row running', async () => {
    using live = await createLiveTestDatabase();
    const { id, importId, lib } = await pendingImport(live.db, 'superseded', ['A.dng', 'B.dng']);
    const attempt = recordedAttempt('paused');

    const running = runnerWith(async () => {
      attempt.stop = 'superseded';
    }).run(importId, attempt);

    await expect(running).rejects.toBeInstanceOf(AttemptSuperseded);
    const after = (await getImport(id))!;
    expect(after.status).toBe('running');
    expect(after.locked_by).toBe('paused');
    expect(after.counts.copied).toBe(1);
    expect(await landed(lib, 'B.dng')).toBe(false);
  });

  test('an attempt a later delivery replaced stops and leaves the import to that one', async () => {
    using live = await createLiveTestDatabase();
    const { id, importId } = await pendingImport(live.db, 'replaced', ['A.dng', 'B.dng', 'C.dng']);

    const running = runnerWith(async () => {
      await claimImport(id, 'replacement');
    }).run(importId, recordedAttempt('original'));

    await expect(running).rejects.toBeInstanceOf(ImportTakenOver);
    const after = (await getImport(id))!;
    expect(after.status).toBe('running');
    expect(after.locked_by).toBe('replacement');
    expect(after.error ?? null).toBeNull();
    expect(after.progress.current).toBeLessThan(3);
  });

  test('a cancel made in Temporal ends the import cancelled, keeping what was copied', async () => {
    using live = await createLiveTestDatabase();
    const { id, importId, lib } = await pendingImport(live.db, 'cancelled', ['A.dng', 'B.dng']);
    const attempt = recordedAttempt('cancelled');

    const outcome = await runnerWith(async () => {
      attempt.stop = 'cancel';
    }).run(importId, attempt);

    expect(outcome).toEqual({ outcome: 'cancelled' });
    const after = (await getImport(id))!;
    expect(after.status).toBe('cancelled');
    expect(after.counts.copied).toBe(1);
    expect(await landed(lib, 'A.dng')).toBe(true);
    expect(await landed(lib, 'B.dng')).toBe(false);
  });

  test('every file outcome reaches the engine heartbeat', async () => {
    using live = await createLiveTestDatabase();
    const { importId } = await pendingImport(live.db, 'progress', ['A.dng', 'B.dng']);
    const attempt = recordedAttempt('progress');

    await runnerWith(async () => {}).run(importId, attempt);

    expect(attempt.beats).toContainEqual({ current: 1, total: 2 });
    expect(attempt.beats.at(-1)).toEqual({ current: 2, total: 2 });
  });

  test('a long copy still heartbeats on a timer', async () => {
    using live = await createLiveTestDatabase();
    const { importId } = await pendingImport(live.db, 'long-copy', ['A.dng']);
    const attempt = recordedAttempt('long-copy');
    const observed = { beatsBefore: 0, beatsAfter: 0 };

    const outcome = await runnerWith(async () => {
      observed.beatsBefore = attempt.beats.length;
      await new Promise((resolve) => setTimeout(resolve, 450));
      observed.beatsAfter = attempt.beats.length;
    }, 100).run(importId, attempt);

    expect(outcome).toEqual({ outcome: 'done' });
    expect(observed.beatsAfter).toBeGreaterThan(observed.beatsBefore + 1);
  });

  test('an unexpected error fails the import with its message instead of escaping', async () => {
    using live = await createLiveTestDatabase();
    const { id, importId } = await pendingImport(live.db, 'vanished', ['A.dng', 'B.dng']);

    const outcome = await runnerWith(async () => {
      run(live.db, `DELETE FROM import_files WHERE import_id = ? AND idx = 1`, importId);
    }).run(importId, recordedAttempt('vanished'));

    expect(outcome).toEqual({
      outcome: 'failed',
      error: expect.stringContaining('no import_files row'),
    });
    expect((await getImport(id))!.status).toBe('failed');
  });
});
