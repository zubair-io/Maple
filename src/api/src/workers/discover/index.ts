/**
 * Discover producer — wraps the chokidar Watcher and inserts image docs with
 * the full `stages` skeleton for every new or modified file.
 *
 * This module exports two things:
 *  1. `startDiscover(opts)` — called by the supervisor (or by tests) to start
 *     the watcher in the current process. Returns a handle with `stop()`.
 *  2. A `main()` function guarded by `import.meta.main` that the supervisor
 *     spawns as a child process.
 *
 * The discover child is NOT a stage controller — it does not use `defineStage`
 * or `runStage`. It owns only the insert side: on a new or modified file it
 * upserts the image doc with the skeleton, letting hash/exif/thumb controllers
 * pick it up naturally on their next poll tick.
 *
 * On rename: updates abs_path + filename only, preserves stage progress.
 * On remove: soft-deletes (sets deleted_at).
 * On modify: re-issues the upsert so mtime is refreshed; $setOnInsert guards
 *            against clobbering existing stage progress.
 */
import * as path from 'node:path';
import * as fsNode from 'node:fs/promises';
import { ObjectId } from 'mongodb';
import { Watcher, type WatchEvent } from '../../indexer/watcher.ts';
import { blankStagesSkeleton } from '../stages/manifest.ts';
import { child } from '../../log.ts';
import {
  assetsCollection,
  foldersCollection,
  getDb,
  ensureIndexes,
  closeDb,
} from '../../db/client.ts';
import { recordAndPublishAssetChange } from '../../db/changes.repo.ts';
import { hashFileForId } from '../../indexer/id.ts';

const log = child('discover');

export interface DiscoverOptions {
  /** Absolute paths to watch. One path per registered folder root. */
  roots: string[];
  /** File extensions to index (default: the standard SUPPORTED_EXTS set). */
  include?: Set<string>;
  /** Debounce window in ms (default: 250). */
  debounceMs?: number;
}

export interface DiscoverHandle {
  stop: () => Promise<void>;
}

const SUPPORTED_EXTS = new Set([
  '.dng',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.raf',
  '.orf',
  '.rw2',
  '.pef',
  '.srw',
  '.x3f',
  '.3fr',
  '.mef',
  '.erf',
  '.mrw',
  '.jpg',
  '.jpeg',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
]);

/**
 * Convert `path.relative` output to the POSIX form stored in
 * `FileInfo.path`: `""` for empty/".", forward-slash separators on every
 * host. The API runs on Linux/macOS in production, but normalising here
 * keeps the on-wire contract honest if someone runs the harness on
 * Windows.
 */
function toPosixRelDir(relDir: string): string {
  if (relDir === '' || relDir === '.') return '';
  return relDir.split(path.sep).join('/');
}

/**
 * Build the `fileinfo[0]` entry for a file inside a known library root.
 * Returns null when the file path escapes the library (defensive — should
 * not happen because the watcher only emits events under registered roots,
 * but cheap to check and avoids storing `path: "../escape"`).
 */
function buildFileinfoEntry(
  libraryRoot: string,
  absPath: string,
  folderId: ObjectId,
): { path: string; filename: string; library_id: ObjectId } | null {
  const relDir = path.relative(libraryRoot, path.dirname(absPath));
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) return null;
  return {
    path: toPosixRelDir(relDir),
    filename: path.basename(absPath),
    library_id: folderId,
  };
}

/**
 * Exported for integration tests — allows tests to simulate events without
 * waiting for chokidar's polling interval (60s/300s in production config).
 *
 * `libraryRoot` is the absolute filesystem path of the library that owns
 * `folderId`. The supervisor caches this from the folders collection at
 * boot (see `startDiscover`) so handleEvent doesn't pay a Mongo round-trip
 * per FS event. Tests that drive `handleEvent` directly must pass it.
 */
export async function handleEvent(
  event: WatchEvent,
  folderId: ObjectId,
  libraryRoot: string,
): Promise<void> {
  const { kind, absPath, fromPath } = event;
  const coll = await assetsCollection();

  if (kind === 'removed') {
    // Read the asset ID before the soft-delete so the change event can
    // carry it. Soft-deletes preserve the row, so this never races with
    // a delete-then-readd.
    const existing = await coll.findOne(
      { abs_path: absPath },
      { projection: { _id: 1, folder_id: 1 } },
    );
    await coll.updateOne({ abs_path: absPath }, { $set: { deleted_at: new Date().toISOString() } });
    log.info({ absPath }, 'soft-deleted');
    if (existing) {
      await recordAndPublishAssetChange({
        kind: 'delete',
        asset_id: existing._id,
        folder_id: existing.folder_id ?? folderId,
        abs_path: absPath,
      });
    }
    return;
  }

  if (kind === 'renamed' && fromPath) {
    const before = await coll.findOne(
      { abs_path: fromPath },
      { projection: { _id: 1, fileinfo: 1 } },
    );
    if (!before) {
      log.warn({ fromPath, absPath }, 'renamed event but no existing row — skipping');
      return;
    }

    // A rename is not a new location — we overwrite the primary entry
    // in place so `fileinfo.length` stays the same.
    const entry = buildFileinfoEntry(libraryRoot, absPath, folderId);
    if (!entry) {
      log.warn({ libraryRoot, absPath }, 'rename target escapes library root — skipping');
      return;
    }
    const newFileinfo = [entry, ...(before.fileinfo ?? []).slice(1)];

    await coll.updateOne(
      { abs_path: fromPath },
      {
        $set: {
          abs_path: absPath,
          // Watcher renames may cross library roots — the discover
          // supervisor invokes `handleEvent` with `folderId` set to
          // the NEW library that owns `absPath`, but the legacy
          // `folder_id` field on the row still points at the OLD
          // library if we don't update it. PR 7 removes `folder_id`
          // entirely; until then, keep it in sync so per-folder
          // queries (e.g. `GET /api/folders/:id/assets`) don't list
          // a renamed file under its previous library.
          folder_id: folderId,
          filename: path.basename(absPath),
          fileinfo: newFileinfo,
          indexed_at: new Date().toISOString(),
          deleted_at: null,
        },
      },
    );
    log.info({ from: fromPath, to: absPath }, 'renamed');
    // Renames keep the same _id but change the path — surface as an
    // `update` so File Provider clients pick up the new filename.
    await recordAndPublishAssetChange({
      kind: 'update',
      asset_id: before._id,
      folder_id: folderId,
      abs_path: absPath,
    });
    return;
  }

  // created or modified — hash, then dedup by maple_id.
  //
  // PR 2: hashing moves from the post-insert `hash` stage to here so the
  // unique `maple_id_1` index becomes the dedup gate. When two files have
  // identical content the second event no longer inserts a new row — it
  // $push's a fileinfo entry on the existing row.
  //
  // Hard-skip when the file escapes the library root — we'd rather log a
  // warning and drop the event than insert a row without a valid fileinfo
  // entry (which would violate the invariant that every live asset has
  // length ≥ 1).
  const fileinfoEntry = buildFileinfoEntry(libraryRoot, absPath, folderId);
  if (!fileinfoEntry) {
    log.warn({ libraryRoot, absPath }, 'event absPath escapes library root — skipping insert');
    return;
  }
  const filename = path.basename(absPath);

  let hashed: Awaited<ReturnType<typeof hashFileForId>>;
  try {
    hashed = await hashFileForId(absPath);
  } catch (err) {
    // hashFileForId opens + reads + stats the file. ENOENT here means the
    // file was unlinked between the watcher fire and our read; treat like
    // a stat failure (skip the event, watcher will fire again on next
    // poll if the file reappears).
    log.warn(
      { absPath, err: err instanceof Error ? err.message : err },
      'hash failed after watch event — skipping',
    );
    return;
  }
  const now = new Date().toISOString();

  // Find any existing row for this content. We project narrowly so the
  // doc body stays small even on libraries with many assets.
  const existing = await coll.findOne(
    { maple_id: hashed.maple_id },
    { projection: { _id: 1, fileinfo: 1 } },
  );

  if (existing) {
    // Same content — record the new location if it's not already on the
    // row, refresh timestamps. We DO NOT touch any user-edited fields
    // (rating, flag, color_label, sidecar mirror, …) on a dedup hit.
    const list = (existing.fileinfo ?? []) as Array<{
      path: string;
      filename: string;
      library_id: ObjectId;
      deleted_at?: string | null;
    }>;
    const dupIdx = list.findIndex(
      (e) =>
        e.library_id.equals(fileinfoEntry.library_id) &&
        e.path === fileinfoEntry.path &&
        e.filename === fileinfoEntry.filename,
    );
    if (dupIdx === -1) {
      await coll.updateOne(
        { _id: existing._id },
        {
          $push: { fileinfo: fileinfoEntry as never },
          $set: {
            indexed_at: now,
            deleted_at: null,
            mtime: hashed.mtime,
            size: hashed.size,
          },
        },
      );
      log.info({ absPath, maple_id: hashed.maple_id, dedup: 'append' }, 'deduped — new location');
    } else {
      // Already-known location: clear any per-entry deleted_at on a
      // re-discover, refresh top-level timestamps.
      await coll.updateOne(
        { _id: existing._id },
        {
          $set: {
            indexed_at: now,
            deleted_at: null,
            mtime: hashed.mtime,
            size: hashed.size,
            [`fileinfo.${dupIdx}.deleted_at`]: null,
          },
        },
      );
      log.debug({ absPath, maple_id: hashed.maple_id, dedup: 'noop' }, 'idempotent re-discover');
    }
    await recordAndPublishAssetChange({
      kind: kind === 'created' ? 'create' : 'update',
      asset_id: existing._id,
      folder_id: folderId,
      abs_path: absPath,
    });
    return;
  }

  // No existing row for this content — insert. The hash stage's post-
  // insert work has already happened (sha1_head + maple_id are in
  // `hashed`); we mark `stages.hash.version` to its target so the stage
  // runner skips this row on its next poll.
  const stagesSkeleton = blankStagesSkeleton() as Record<string, { version: number }>;
  if (stagesSkeleton.hash) stagesSkeleton.hash.version = 1;

  const insertedId = new ObjectId();
  try {
    await coll.insertOne({
      _id: insertedId,
      abs_path: absPath,
      folder_id: folderId,
      filename,
      fileinfo: [fileinfoEntry],
      rating: 0,
      flag: 0,
      color_label: '',
      exif: null,
      maple_id: hashed.maple_id,
      sha1_head: hashed.sha1_head,
      size: hashed.size,
      mtime: hashed.mtime,
      indexed_at: now,
      deleted_at: null,
      stages: stagesSkeleton,
    } as never);
  } catch (err) {
    // E11000 means another worker raced us to insert this maple_id
    // between our findOne and insertOne. Fall back to the append path.
    const code = (err as { code?: number } | null)?.code;
    if (code === 11000) {
      const winner = await coll.findOne(
        { maple_id: hashed.maple_id },
        { projection: { _id: 1, fileinfo: 1 } },
      );
      if (winner) {
        const list = (winner.fileinfo ?? []) as Array<{
          path: string;
          filename: string;
          library_id: ObjectId;
        }>;
        const dupIdx = list.findIndex(
          (e) =>
            e.library_id.equals(fileinfoEntry.library_id) &&
            e.path === fileinfoEntry.path &&
            e.filename === fileinfoEntry.filename,
        );
        if (dupIdx === -1) {
          await coll.updateOne(
            { _id: winner._id },
            { $push: { fileinfo: fileinfoEntry as never } },
          );
        }
        await recordAndPublishAssetChange({
          kind: kind === 'created' ? 'create' : 'update',
          asset_id: winner._id,
          folder_id: folderId,
          abs_path: absPath,
        });
        log.info(
          { absPath, maple_id: hashed.maple_id, dedup: 'race-loser' },
          'race lost — appended to winner',
        );
        return;
      }
    }
    throw err;
  }

  log.info({ absPath, kind, maple_id: hashed.maple_id }, 'inserted');
  await recordAndPublishAssetChange({
    kind: kind === 'created' ? 'create' : 'update',
    asset_id: insertedId,
    folder_id: folderId,
    abs_path: absPath,
  });
}

/**
 * Resolve the (folder_id, library_root) pair for an absolute file path by
 * longest-prefix match against the list of registered folders. Returns
 * `null` when no registered folder claims the path.
 */
function resolveFolder(
  absPath: string,
  folders: Array<{ _id: ObjectId; path: string }>,
): { id: ObjectId; root: string } | null {
  let best: { _id: ObjectId; path: string } | null = null;
  for (const f of folders) {
    const root = f.path.endsWith('/') ? f.path : f.path + '/';
    if (absPath.startsWith(root) || absPath === f.path) {
      if (!best || f.path.length > best.path.length) {
        best = f;
      }
    }
  }
  return best ? { id: best._id, root: best.path } : null;
}

/**
 * Start the discover loop. Called by the supervisor in-process (or by tests).
 * Loads registered folder documents once at start time and caches the
 * `(folder_id, library_root)` pair so each FS event resolves in-process,
 * avoiding a Mongo round-trip per watcher tick.
 *
 * Folder changes today require a restart of the worker (the supervisor
 * cycles it). A SIGHUP-to-refresh hook could be added if hot folder
 * registration becomes important.
 */
export async function startDiscover(opts: DiscoverOptions): Promise<DiscoverHandle> {
  const include = opts.include ?? SUPPORTED_EXTS;

  const foldersColl = await foldersCollection();
  const folderDocs = (await foldersColl.find({}, { projection: { path: 1 } }).toArray()) as Array<{
    _id: ObjectId;
    path: string;
  }>;

  const watcher = new Watcher({
    roots: opts.roots,
    debounceMs: opts.debounceMs,
    include,
    onEvent: (event: WatchEvent) => {
      const folder = resolveFolder(event.absPath, folderDocs);
      if (!folder) {
        log.warn({ absPath: event.absPath }, 'no registered folder matched — skipping event');
        return;
      }
      handleEvent(event, folder.id, folder.root).catch((err) => {
        log.error(
          { absPath: event.absPath, err: err instanceof Error ? err.message : err },
          'event handler failed',
        );
      });
    },
  });

  return {
    stop: async () => {
      await watcher.close();
    },
  };
}

/**
 * Child-process entry point. The supervisor spawns:
 *   bun src/api/src/workers/discover/index.ts <root1> [<root2> ...]
 *
 * Connects to Mongo, starts the watcher, runs until SIGTERM/SIGINT.
 * folder_id is resolved per-event from the registered folders collection.
 */
async function main(): Promise<void> {
  const [, , ...roots] = process.argv;
  if (roots.length === 0) {
    process.stderr.write('Usage: bun src/api/src/workers/discover/index.ts <root1> [<root2>...]\n');
    process.exit(1);
  }

  await getDb().then(() => ensureIndexes());

  const handle = await startDiscover({ roots });
  log.info({ roots }, 'discover started');

  async function shutdown(): Promise<void> {
    log.info('shutting down discover');
    await handle.stop();
    await closeDb();
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    shutdown().catch((e) => {
      log.error({ err: e instanceof Error ? e.message : e }, 'shutdown error');
      process.exit(1);
    });
  });
  process.on('SIGINT', () => {
    shutdown().catch((e) => {
      log.error({ err: e instanceof Error ? e.message : e }, 'shutdown error');
      process.exit(1);
    });
  });
}

// Only run main when executed directly, not when imported by tests.
if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`[discover] fatal: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  });
}
