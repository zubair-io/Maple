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
 * upserts the image doc with the skeleton, letting exif/thumb controllers
 * pick it up naturally on their next poll tick.
 *
 * On rename: rewrites `fileinfo[0]`, preserves stage progress.
 * On remove: soft-deletes (sets deleted_at).
 * On modify: re-issues the upsert so mtime is refreshed; $setOnInsert guards
 *            against clobbering existing stage progress.
 *
 * Layout (split per #253, refs #134):
 *   - `types.ts`        — `DiscoverOptions`, `DiscoverHandle`, `SUPPORTED_EXTS`,
 *                         and the pure path-normalisation helpers.
 *   - `handle-event.ts` — `handleEvent`, the per-event dedup/insert core.
 *   - `index.ts` (here) — folder-resolution, the `startDiscover` factory, the
 *                         child-process `main()`, and the public re-exports.
 */
import type { ObjectId } from 'mongodb';
import { Watcher, type WatchEvent } from '../../indexer/watcher.ts';
import { child } from '../../log.ts';
import { foldersCollection, getDb, ensureIndexes, closeDb } from '../../db/client.ts';
import { SUPPORTED_EXTS, type DiscoverHandle, type DiscoverOptions } from './types.ts';
import { handleEvent } from './handle-event.ts';

// Public re-exports — external consumers (`src/api/src/index.ts`,
// `src/api/src/routes/folders.ts`, the test suite) import these from
// `./index.ts` and must stay stable across the split.
export { handleEvent } from './handle-event.ts';
export type { DiscoverOptions, DiscoverHandle } from './types.ts';

const log = child('discover');

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
