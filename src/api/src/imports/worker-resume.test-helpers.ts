/**
 * Staging for the suites that stop one import attempt partway and run the next:
 * a pending import over real temp directories, attempts whose worker dies at a
 * chosen database write, and runners that record what reaches the indexer.
 */

import { afterAll, beforeAll, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import type { ImportFileEntry } from '../db/schema.ts';
import { insertFolder } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { recordedAttempt } from '../temporal/recorded-attempt.test-helpers.ts';
import * as repo from './repo.ts';
import { ImportRunner, type ImportRunnerDeps } from './worker.ts';

export const DIR = '2024/03';
export const HASH = { maple_id: 'm', sha1_head: 's', size: 1, mtime: 0 };

let tmp: string;
let previousMapleRoots: string | undefined;

export function useImportScratch(): void {
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-import-resume-'));
    previousMapleRoots = process.env.MAPLE_ROOTS;
    process.env.MAPLE_ROOTS = await fs.realpath(os.tmpdir());
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (previousMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = previousMapleRoots;
  });
}

export const scratchPath = (sub: string, leaf: string): string => path.join(tmp, sub, leaf);

/** A pending import of `files`, in order, each staged under `<tmp>/<sub>/src`. */
export async function pendingImport(
  db: Database,
  sub: string,
  files: [name: string, kind: ImportFileEntry['kind']][],
) {
  const source = path.join(tmp, sub, 'src');
  const lib = path.join(tmp, sub, 'lib');
  await fs.mkdir(source, { recursive: true });
  await Promise.all(
    files.map(([name]) => fs.writeFile(path.join(source, name), `bytes-${sub}-${name}`)),
  );
  const created = await repo.createImport({
    source_root: source,
    library_id: new ObjectId(insertFolder(db, { path: lib })),
    library_root: lib,
    files: files.map(([name, kind]) => ({
      src: path.join(source, name),
      dest: `${DIR}/${name}`,
      size: 1,
      mtime: 0,
      kind,
      state: 'pending' as const,
      error: null,
    })),
  });
  return {
    id: created._id,
    importId: created._id.toHexString(),
    source: (name: string) => path.join(source, name),
    landed: (name: string) => path.join(lib, DIR, name),
    landedNames: async () => (await fs.readdir(path.join(lib, DIR))).sort(),
    bytes: (name: string) => `bytes-${sub}-${name}`,
  };
}

/** Puts `bytes` at a library path, as a file that is there without this attempt having recorded it. */
export async function place(dest: string, bytes: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
}

export const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

/**
 * The clock of an attempt whose worker dies: every claim, file outcome and
 * terminal write reads the clock first, so once `writes` of those have been
 * made the next one never happens and the row is left `running` under that
 * attempt. Writing or clearing a publish marker reads no clock.
 */
function clockOfWorkerKilledAfter(writes: number): () => Date {
  let made = 0;
  return () => {
    if (made >= writes) throw new Error('worker killed');
    made += 1;
    return new Date();
  };
}

export function clockDoingAtWrite(nth: number, instead: () => void): () => Date {
  let read = 0;
  return () => {
    read += 1;
    if (read === nth) instead();
    return new Date();
  };
}

export async function earlierAttemptMarked(
  id: ObjectId,
  index: number,
  name: string,
): Promise<void> {
  await repo.claimImport(id, 'first');
  await repo.markImportFilePublishing(id, { index, destRel: `${DIR}/${name}`, holder: 'first' });
}

/** A runner that records what it hands to the indexer and what it re-arms. */
export function observedRunner(
  config: { now?: () => Date; deps?: Partial<ImportRunnerDeps> } = {},
) {
  const handed: string[] = [];
  const rearmed: string[] = [];
  const runner = new ImportRunner({
    now: config.now,
    deps: {
      hashFileForId: async () => HASH,
      assetExistsForHash: async () => false,
      handleEvent: async (event) => {
        handed.push((event as { absPath: string }).absPath);
      },
      rearmSidecarMetadataIndex: async (name) => {
        rearmed.push(name);
      },
      ...config.deps,
    },
  });
  return { runner, handed, rearmed };
}

/** An attempt whose worker is killed at the write after `writes` clock-reading ones. */
export async function attemptKilledAfter(writes: number, importId: string, identity = 'first') {
  const killed = observedRunner({ now: clockOfWorkerKilledAfter(writes) });
  await expect(killed.runner.run(importId, recordedAttempt(identity))).rejects.toThrow(
    'worker killed',
  );
  return killed;
}

/** An attempt that must end the import `done`. */
export async function attemptThatFinishes(
  importId: string,
  config: Parameters<typeof observedRunner>[0] = {},
  identity = 'second',
) {
  const next = observedRunner(config);
  expect(await next.runner.run(importId, recordedAttempt(identity))).toEqual({
    outcome: 'done',
  });
  return next;
}

/**
 * An indexer hand-off the worker dies in: `reached` settles when the attempt
 * gets there, and the call never returns, so nothing after it runs.
 */
export function handOffTheWorkerDiesIn() {
  const reached = Promise.withResolvers<void>();
  const handleEvent: ImportRunnerDeps['handleEvent'] = () => {
    reached.resolve();
    return new Promise<never>(() => {});
  };
  return { reached: reached.promise, handleEvent };
}

export const IMAGE_WITH_SIDECAR: [string, ImportFileEntry['kind']][] = [
  ['IMG.xmp', 'sidecar'],
  ['IMG.dng', 'image'],
];

export const states = async (id: ObjectId) =>
  (await repo.getImportFiles(id)).map((file) => file.state);
export const dests = async (id: ObjectId) =>
  (await repo.getImportFiles(id)).map((file) => file.dest);
export const marked = async (id: ObjectId) => [...(await repo.getImportPublishingDests(id))];
