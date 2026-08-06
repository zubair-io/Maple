/**
 * Asset-level relocate (#2629) — the Mongo-aware orchestrator built on the
 * generic crash-safe `relocateFile` primitive (`fs/relocate.ts`). This is
 * the foundation every other file-management feature (rename, move,
 * drag-to-folder, folder move) is meant to call into — see
 * docs/superpowers/specs/2026-08-04-file-management-design.md
 * § "Core architecture" → "The relocate primitive".
 *
 * Resolves the asset's current primary `fileinfo` entry, computes the
 * destination absolute path, and wires the DB repoint (path/filename +
 * thumb/preview stage-version reset + meili re-arm, mirroring the shape
 * `workers/migration/move-backup-asset.ts` already uses) as the
 * primitive's `onVerified` hook — so the write lands strictly BETWEEN the
 * verified copy and the delete-of-original. That ordering is the
 * load-bearing failure-direction contract: any failure up to and including
 * a failed repoint leaves the original completely untouched (at worst a
 * harmless duplicate copy sits at the destination).
 *
 * Deliberately does NOT (yet) handle the `apple_rendered_path` companion or
 * the byte-identical dedupe short-circuit that
 * `workers/migration/move-backup-asset.ts` (`moveBackupAsset`) implements
 * for the geo-relocate route (`routes/library-relocate.ts`). Both are
 * outside this ticket's (#2629) 8-step contract, and `moveBackupAsset` is
 * also shared with the just-landed day-dir-refile migration
 * (`workers/migration/refile-legacy-daydir.ts`) — rewriting its call site
 * risked either silently orphaning Apple-rendered companions for backed-up
 * assets or regressing that migration. `routes/library-relocate.ts` is left
 * calling `moveBackupAsset` as-is; generalizing this primitive to subsume
 * it is tracked as a follow-up: #2667.
 */

import * as path from 'node:path';
import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { MEILI_REARM_SET } from '../people/people-search-reindex.ts';
import { relocateFile, type CollisionPolicy, type RelocateMode } from '../fs/relocate.ts';
import { resolveRelPathUnderRoot } from './address.ts';
import { isSafeFilename } from '../backup/path-formatter.ts';
import { child as childLogger } from '../log.ts';
import type { AssetDoc, FileInfo } from '../db/schema.ts';

const log = childLogger('library/relocate-asset');

/** Cache-writing stages keyed on the asset's path — reset to v0 after a
 * relocate so the workers regenerate the dropped `.maple` cache at the new
 * location (ticket step 7 — never physically relocate cache files, the
 * cache key is path-derived, see docs/caching.md). Matches the sibling
 * constant of the same name/purpose in `workers/migration/move-backup-asset.ts`. */
const CACHE_STAGES = ['thumb', 'preview'] as const;

export interface RelocateAssetInput {
  id: ObjectId;
  mode: RelocateMode;
  collision: CollisionPolicy;
  /** POSIX relative dir under the asset's library root the destination
   * lives in. `''` = library root. */
  destinationPath: string;
  /** Defaults to the asset's current filename. */
  destinationFilename?: string;
}

export type RelocateAssetResult =
  | {
      kind: 'relocated';
      newAbsPath: string;
      newPath: string;
      newFilename: string;
      renamedOnCollision: boolean;
    }
  | { kind: 'skipped'; reason: string }
  | { kind: 'not-found' }
  /** `destinationPath` / `destinationFilename` failed validation — a
   * client-error (400-shaped), distinct from `'error'`'s internal-failure
   * (500-shaped) so callers like `routes/assets/relocate.ts` can map it
   * correctly. Enforced here as defense in depth regardless of whether the
   * caller (e.g. the HTTP route) already validated. */
  | { kind: 'invalid'; error: string }
  | { kind: 'error'; error: string };

/** First fileinfo entry that isn't soft-deleted — the same "canonical live
 * entry" definition `routes/library-relocate.ts` and
 * `workers/migration/move-backup-asset.ts` each keep their own copy of. */
function activeFileInfo(asset: Pick<AssetDoc, 'fileinfo'>): FileInfo | null {
  const list = asset.fileinfo;
  if (!list || list.length === 0) return null;
  for (const entry of list) {
    if (!entry.deleted_at) return entry;
  }
  return null;
}

/** Split an absolute path back into the `(path, filename)` shape
 * `FileInfo` stores, POSIX-separated per the schema's storage contract. */
function splitRelPath(libRoot: string, absPath: string): { relPath: string; filename: string } {
  const rel = path.relative(libRoot, absPath).split(path.sep).join('/');
  const lastSlash = rel.lastIndexOf('/');
  return lastSlash === -1
    ? { relPath: '', filename: rel }
    : { relPath: rel.slice(0, lastSlash), filename: rel.slice(lastSlash + 1) };
}

export async function relocateAsset(input: RelocateAssetInput): Promise<RelocateAssetResult> {
  const c = await assetsCollection();
  const doc = await c.findOne({ _id: input.id });
  if (!doc) return { kind: 'not-found' };

  const primary = activeFileInfo(doc);
  if (!primary) return { kind: 'error', error: 'asset has no live location' };

  const libs = await loadLibraryRoots();
  const libRoot = libs.get(primary.library_id.toHexString());
  if (!libRoot) return { kind: 'error', error: 'library root not found for asset' };

  // Validate BOTH destination parts before touching disk. `destinationPath`
  // is a multi-segment relPath (jailed via the same symlink-safe check the
  // M1 addressing routes share — `resolveRelPathUnderRoot`, tolerant of the
  // destination not existing yet); `destinationFilename` is a single
  // segment, so it gets the stricter no-separators `isSafeFilename` check
  // instead (a relPath jail would happily accept `sub/dir.dng` as a
  // "filename", which is exactly the traversal this guards against).
  let destDir: string;
  try {
    destDir = await resolveRelPathUnderRoot(libRoot, input.destinationPath);
  } catch (err) {
    return { kind: 'invalid', error: err instanceof Error ? err.message : String(err) };
  }
  if (input.destinationFilename !== undefined && !isSafeFilename(input.destinationFilename)) {
    return { kind: 'invalid', error: 'destinationFilename is not a valid single-segment filename' };
  }

  const sourceAbsPath = path.join(libRoot, primary.path, primary.filename);
  const destFilename = input.destinationFilename ?? primary.filename;
  const destAbsPath = path.join(destDir, destFilename);

  if (sourceAbsPath === destAbsPath) {
    return { kind: 'skipped', reason: 'already at destination' };
  }

  const outcome = await relocateFile({
    sourceAbsPath,
    destAbsPath,
    mode: input.mode,
    collision: input.collision,
    callerTag: 'relocateAsset',
    onVerified: async ({ newAbsPath }) => {
      const split = splitRelPath(libRoot, newAbsPath);
      const set: Record<string, unknown> = {
        'fileinfo.$.path': split.relPath,
        'fileinfo.$.filename': split.filename,
        'fileinfo.$.missing_since': null,
        ...MEILI_REARM_SET,
      };
      for (const stage of CACHE_STAGES) {
        set[`stages.${stage}.version`] = 0;
        set[`stages.${stage}.attempts`] = 0;
        set[`stages.${stage}.last_error`] = null;
        set[`stages.${stage}.dead`] = false;
      }
      const res = await c.updateOne(
        {
          _id: input.id,
          fileinfo: {
            $elemMatch: {
              library_id: primary.library_id,
              path: primary.path,
              filename: primary.filename,
              deleted_at: null,
            },
          },
        },
        { $set: set } as never,
      );
      if (res.matchedCount === 0) {
        throw new Error('asset fileinfo entry changed concurrently — aborting relocate');
      }
    },
  });

  switch (outcome.kind) {
    case 'relocated': {
      const split = splitRelPath(libRoot, outcome.newAbsPath);
      log.info(
        {
          id: input.id.toHexString(),
          newAbsPath: outcome.newAbsPath,
          mode: input.mode,
        },
        'relocateAsset: relocated',
      );
      return {
        kind: 'relocated',
        newAbsPath: outcome.newAbsPath,
        newPath: split.relPath,
        newFilename: split.filename,
        renamedOnCollision: outcome.renamedOnCollision,
      };
    }
    case 'skipped':
      return { kind: 'skipped', reason: outcome.reason };
    case 'error':
      return { kind: 'error', error: outcome.error };
  }
}
