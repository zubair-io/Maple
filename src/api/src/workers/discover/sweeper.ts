/**
 * Discover reconciliation sweep — the chokidar replacement. Walks one directory
 * per call: enqueues subdirs onto the frontier, emits created/modified for new
 * or changed images via the injected `handleEvent`, and emits removed for
 * assets recorded in this dir whose file is gone (per-directory diff — no
 * whole-tree state, no per-asset "seen" write).
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ObjectId } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import { SUPPORTED_EXTS } from './types.ts';
import type { WatchEvent } from './types.ts';
import * as frontier from './frontier.repo.ts';
import type { FrontierDir } from './frontier.repo.ts';

export interface ReconcileDeps {
  handleEvent: (event: WatchEvent, folderId: ObjectId, libraryRoot: string) => Promise<void>;
  folderId: ObjectId;
}

function isSupported(name: string): boolean {
  return SUPPORTED_EXTS.has(path.extname(name).toLowerCase());
}

/** Relative directory path of `absDir` under `root`, '' for the root itself. */
function relDir(root: string, absDir: string): string {
  const rel = path.relative(root, absDir);
  return rel === '' ? '' : rel;
}

export async function visitDirectory(
  dir: FrontierDir,
  root: string,
  deps: ReconcileDeps,
): Promise<void> {
  const { folderId } = deps;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir.dir_path, { withFileTypes: true });
  } catch {
    // Vanished/unreadable dir: drop it from the frontier and move on.
    await frontier.completeDir(dir._id);
    return;
  }

  const subdirs: string[] = [];
  const filesOnDisk = new Map<string, string>(); // filename -> absPath (images only)

  for (const ent of entries) {
    const abs = path.join(dir.dir_path, ent.name);
    if (ent.isDirectory()) { subdirs.push(abs); continue; }
    if (!ent.isFile() || !isSupported(ent.name)) continue;
    filesOnDisk.set(ent.name, abs);
  }

  // ONE indexed read per dir: the non-deleted assets recorded directly in it.
  // Drives BOTH "what's new" and "what's gone" — so writes happen only on real
  // changes, never a per-file upsert storm.
  const rel = relDir(root, dir.dir_path);
  const coll = await assetsCollection();
  const recorded = (await coll
    .find(
      { deleted_at: null, fileinfo: { $elemMatch: { library_id: folderId, path: rel } } },
      { projection: { 'fileinfo.$': 1 } },
    )
    .toArray()) as Array<{ fileinfo: Array<{ filename: string }> }>;
  const recordedNames = new Set<string>();
  for (const a of recorded) {
    const fn = a.fileinfo?.[0]?.filename;
    if (fn) recordedNames.add(fn);
  }

  // New files only → created (handleEvent upserts the stage skeleton). Files
  // already recorded are SKIPPED — no write.
  for (const [name, abs] of filesOnDisk) {
    if (recordedNames.has(name)) continue;
    await deps.handleEvent({ kind: 'created', absPath: abs }, folderId, root);
  }

  // Recorded files no longer on disk → removed (soft-delete via handleEvent).
  for (const a of recorded) {
    const fn = a.fileinfo?.[0]?.filename;
    if (fn && !filesOnDisk.has(fn)) {
      await deps.handleEvent({ kind: 'removed', absPath: path.join(dir.dir_path, fn) }, folderId, root);
    }
  }

  await frontier.enqueueDirs(folderId, subdirs, dir.sweep_gen);
  await frontier.completeDir(dir._id);
}
