/**
 * Publishing one import file into the library: resolve where it lands, mark the
 * row, copy without clobbering, and report the per-file outcome. Filesystem
 * failures become a `failed` outcome so one bad file does not abort the import;
 * a failure to write the marker is not one of those and is thrown.
 */

import { filesIdentical } from '../backup/fs-util.ts';
import type { ImportFileEntry } from '../db/schema.ts';
// Mirror-aware drop-in; only ever stats here.
import fs from '../fs/mirrored.ts';
import { copyFileAtomic, destAbsPath, resolveDest } from './copy.ts';

/** Max no-clobber publish attempts before a file is marked failed (each
 * attempt re-resolves a fresh sibling; only a sustained adversarial racer
 * exhausts this). */
const PUBLISH_RETRIES = 25;

export interface CopyOutcome {
  state: ImportFileEntry['state'];
  error: string | null;
  destRel: string;
  /** The file was already at `destRel`, put there by an earlier attempt of this import. */
  landedEarlier?: true;
  /** Skipped because `destRel` already holds these exact bytes, not because another file is there. */
  alreadyPresent?: true;
}

interface PublishOptions {
  /** Leave a different file already at the destination alone; nothing is copied under a sibling name. */
  keepExisting?: boolean;
  /** The name an earlier attempt of this import marked before publishing this file. */
  earlierDest?: string | null;
  /** Runs with the resolved name before every publish, so the name is committed first. */
  beforePublish?: (destRel: string) => Promise<void>;
}

type Tried<T> = { ok: true; value: T } | { ok: false; error: string };

async function tried<T>(work: () => Promise<T>): Promise<Tried<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * True when `destRel` under the library holds exactly the bytes of `src`. Only
 * a free name is "no": a file that cannot be read throws, because calling it
 * different would send the caller on to copy the image a second time.
 */
export async function holdsSource(
  libraryRoot: string,
  destRel: string,
  src: string,
): Promise<boolean> {
  const destAbs = destAbsPath(libraryRoot, destRel);
  const present = await fs.stat(destAbs).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err?.code === 'ENOENT') return false;
      throw err;
    },
  );
  return present && (await filesIdentical(src, destAbs));
}

function landedAtMarkedName(
  libraryRoot: string,
  src: string,
  destRel: string,
  earlierDest: string | null,
  alreadyPresent: boolean,
): Promise<Tried<string | null>> {
  if (earlierDest === null) return Promise.resolve({ ok: true, value: null });
  if (alreadyPresent && earlierDest === destRel) {
    return Promise.resolve({ ok: true, value: earlierDest });
  }
  return tried(async () =>
    (await holdsSource(libraryRoot, earlierDest, src)) ? earlierDest : null,
  );
}

async function copyTo(
  libraryRoot: string,
  src: string,
  destRel: string,
  target: string,
  beforePublish: PublishOptions['beforePublish'],
): Promise<CopyOutcome | null> {
  await beforePublish?.(target);
  const published = await tried(() => copyFileAtomic(src, destAbsPath(libraryRoot, target)));
  if (!published.ok) return { state: 'failed', error: published.error, destRel };
  return published.value ? { state: 'copied', error: null, destRel: target } : null;
}

/** One try at the publish; `null` when another writer took the resolved name first. */
async function publishOnce(
  libraryRoot: string,
  src: string,
  destRel: string,
  options: PublishOptions,
): Promise<CopyOutcome | null> {
  const { keepExisting = false, earlierDest = null, beforePublish } = options;
  const resolved = await tried(() => resolveDest(libraryRoot, destRel, src));
  if (!resolved.ok) return { state: 'failed', error: resolved.error, destRel };
  const { destRel: target, alreadyPresent } = resolved.value;
  const landed = await landedAtMarkedName(libraryRoot, src, destRel, earlierDest, alreadyPresent);
  if (!landed.ok) return { state: 'failed', error: landed.error, destRel };
  if (landed.value !== null) {
    return { state: 'copied', error: null, destRel: landed.value, landedEarlier: true };
  }
  if (alreadyPresent) {
    return { state: 'skipped_duplicate', error: null, destRel, alreadyPresent: true };
  }
  if (keepExisting && target !== destRel) {
    return { state: 'skipped_duplicate', error: null, destRel };
  }
  return copyTo(libraryRoot, src, destRel, target, beforePublish);
}

/**
 * Copy `src` to `destRel` under the library, resolving on-disk collisions to a
 * free sibling. Retries when a no-clobber publish loses a cross-process race
 * for the destination.
 *
 * The attempt that marked `earlierDest` can still be finishing the same copy.
 * The marked name is looked at after the destination is resolved and before
 * each publish: a copy that attempt lands before the look is found by it, and
 * one it lands afterwards wins the no-clobber publish, which sends this one
 * round to look again.
 */
export async function publishFile(
  libraryRoot: string,
  src: string,
  destRel: string,
  options: PublishOptions = {},
): Promise<CopyOutcome> {
  for (let attempt = 0; attempt < PUBLISH_RETRIES; attempt++) {
    const outcome = await publishOnce(libraryRoot, src, destRel, options);
    if (outcome !== null) return outcome;
  }
  return {
    state: 'failed',
    error: `could not publish ${destRel} after ${PUBLISH_RETRIES} attempts`,
    destRel,
  };
}
