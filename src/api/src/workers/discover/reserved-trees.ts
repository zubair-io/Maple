/**
 * Reserved-tree guards for the discover producer — the chokepoint filter that
 * keeps Maple's own bookkeeping trees out of the assets collection.
 *
 * Two trees are reserved under every library root:
 *
 *   - `.maple/` — the derivative cache. Indexing it turns each thumb/preview
 *     into a phantom asset whose own derivatives land one `.maple/` deeper,
 *     which the next sweep indexes too — the self-feeding
 *     `.maple/previews/.maple/…` recursion this guard was born from.
 *   - `_duplicates/` — the DeDuplicate quarantine (`fs/duplicates.ts`).
 *     Indexing a quarantined copy re-attaches it (content-dedup) to the very
 *     asset it was split from, and the next dedupe pass then nests it under
 *     `_duplicates/_duplicates/…`.
 *
 * The sweeper filters both at directory-walk time, but `handleEvent` is also
 * fed by the imports hand-off, browse-triggered indexing, the pano on-demand
 * path, the folder walkers, and library modify events — so the refusal must
 * live at the chokepoint, not in each producer.
 *
 * A refused rename is NOT translated into a create/remove: no production
 * producer emits `renamed` events today (the chokidar watcher is retired;
 * renames are reconciled by the sweep's `rename-reconcile.ts`), so refusal
 * simply degrades to the sweep reconciliation the system already relies on
 * for any unwatched filesystem change.
 */

import * as path from 'node:path';
import { DUPLICATES_DIR_NAME } from '../../fs/duplicates.ts';
import { child } from '../../log.ts';
import type { WatchEvent } from './types.ts';

const log = child('discover');

/** True when `absPath` sits inside `libraryRoot` and some segment of its
 * relative path equals `segment` — the shared shape of both guards. The
 * outside-the-root check compares whole segments (`..` alone or `../…`), not
 * `startsWith('..')` — a real directory named `..foo` must not read as a
 * traversal and slip past the guard. */
function hasReservedSegment(libraryRoot: string, absPath: string, segment: string): boolean {
  const rel = path.relative(libraryRoot, absPath);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return false;
  }
  return rel.split(path.sep).includes(segment);
}

/** absPath lives inside the `.maple/` derivative cache (any depth). */
export function isInsideMapleCache(libraryRoot: string, absPath: string): boolean {
  return hasReservedSegment(libraryRoot, absPath, '.maple');
}

/** absPath lives inside the `_duplicates/` quarantine (any depth). */
export function isInsideDuplicatesDir(libraryRoot: string, absPath: string): boolean {
  return hasReservedSegment(libraryRoot, absPath, DUPLICATES_DIR_NAME);
}

/**
 * Chokepoint check for `handleEvent`: true (already logged) when the event
 * touches a reserved tree — its `absPath`, or a rename's `fromPath`, lies
 * inside `.maple/` or `_duplicates/` — and must be refused.
 */
export function refusesReservedTreeEvent(
  event: Pick<WatchEvent, 'kind' | 'absPath' | 'fromPath'>,
  libraryRoot: string,
): boolean {
  const { kind, absPath, fromPath } = event;
  const paths = kind === 'renamed' && fromPath ? [absPath, fromPath] : [absPath];
  const hit = paths.find(
    (p) => isInsideMapleCache(libraryRoot, p) || isInsideDuplicatesDir(libraryRoot, p),
  );
  if (hit === undefined) return false;
  log.warn({ libraryRoot, path: hit, kind }, 'event touches a reserved tree — refusing');
  return true;
}
