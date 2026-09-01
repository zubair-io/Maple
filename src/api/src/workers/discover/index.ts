/**
 * Discover producer — drives a breadth-first reconciliation sweep (one
 * directory per tick) in place of the retired chokidar polling watcher.
 *
 * This module exports two things:
 *  1. `startDiscover(opts)` — called by the supervisor (or by tests) to start
 *     one `SweeperLoop` per registered folder root. Returns a handle with `stop()`.
 *  2. A `main()` function guarded by `import.meta.main` that the supervisor
 *     spawns as a child process.
 *
 * The discover child is NOT a stage controller — it does not use `defineStage`
 * or `runStage`. It owns only the insert side: on a new or modified file it
 * upserts the image doc with the skeleton, letting exif/thumb controllers
 * pick it up naturally on their next poll tick.
 *
 * On remove: soft-deletes (sets deleted_at) via handleEvent.
 *
 * Layout (split per #253, refs #134):
 *   - `types.ts`               — `DiscoverOptions`, `DiscoverHandle`, `WatchEvent`,
 *                                `SUPPORTED_EXTS`, and the pure path-normalisation helpers.
 *   - `handle-event.ts`        — `handleEvent`, the per-event dedup/insert core.
 *   - `frontier.repo.ts`       — Mongo-backed frontier queue (claim/complete/enqueue).
 *   - `sweeper.ts`             — `visitDirectory`, `advanceSweep`, `SweeperLoop`.
 *   - `discover-config.repo.ts`— read/write `discover` row in `worker_config`.
 *   - `index.ts` (here)        — folder-resolution, the `startDiscover` factory, the
 *                                child-process `main()`, and the public re-exports.
 */
import type { ObjectId } from 'mongodb';
import { child } from '../../log.ts';
import { foldersCollection, getDb, ensureIndexes, closeDb } from '../../db/client.ts';
import { type DiscoverHandle, type DiscoverOptions } from './types.ts';
import { handleEvent } from './handle-event.ts';
import { SweeperLoop } from './sweeper.ts';
import { loadDiscoverConfig } from './discover-config.repo.ts';
import { seedRoot, remainingForGen } from './frontier.repo.ts';
import { mostSpecificRoot } from '../../fs/root-match.ts';
import { readCheckpoint } from '../../indexer/checkpoint.ts';

// Public re-exports — external consumers (`src/api/src/index.ts`,
// `src/api/src/routes/folders.ts`, the test suite) import these from
// `./index.ts` and must stay stable across the split.
export { handleEvent } from './handle-event.ts';
export type { DiscoverOptions, DiscoverHandle, WatchEvent } from './types.ts';

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
  // Containment via the shared `path.relative` rule (#3094). The literal
  // `root + '/'` boundary this used could never match on a Windows-hosted
  // server, where the sweep's absolute paths are backslashed — every file
  // resolved to no folder at all. Longest-prefix behaviour is unchanged:
  // `mostSpecificRoot` picks the deepest containing root, and a path equal to
  // a root still matches (the sweep walks directories, not just files).
  const hit = mostSpecificRoot(
    absPath,
    folders.map((f) => [f, f.path] as const),
  );
  return hit ? { id: hit.key._id, root: hit.key.path } : null;
}

/**
 * Start the discover sweep. Called by the supervisor in-process (or by tests).
 * Loads registered folder documents once at start time, seeds the frontier for
 * each root, and runs one `SweeperLoop` per root. The sweep reads its pacing
 * and pause-state from `worker_config` every tick — no restart needed for
 * config changes.
 *
 * Folder changes today require a restart of the worker (the supervisor
 * cycles it). A SIGHUP-to-refresh hook could be added if hot folder
 * registration becomes important.
 */
export async function startDiscover(opts: DiscoverOptions): Promise<DiscoverHandle> {
  const foldersColl = await foldersCollection();
  const folderDocs = (await foldersColl.find({}, { projection: { path: 1 } }).toArray()) as Array<{
    _id: ObjectId;
    path: string;
  }>;

  const loops: SweeperLoop[] = [];
  for (const root of opts.roots) {
    const folder = resolveFolder(root, folderDocs) ?? resolveFolder(root + '/', folderDocs);
    if (!folder) {
      log.warn({ root }, 'no registered folder matched root — skipping');
      continue;
    }
    // Resume the persisted sweep generation if one exists; otherwise start
    // from gen 1. Only (re)seed the root when that generation's frontier is
    // empty — a fresh start or a crash that happened between writeCheckpoint
    // and seedRoot in advanceSweep. When the frontier already has rows we
    // skip the seed so we don't double-enqueue the root directory.
    const cp = await readCheckpoint(folder.id.toHexString());
    const gen = cp?.sweepGen ?? 1;
    if ((await remainingForGen(folder.id, gen)) === 0) {
      await seedRoot(folder.id, root, gen);
    }
    const loop = new SweeperLoop({
      folderId: folder.id,
      root,
      startGen: gen,
      deps: { folderId: folder.id, handleEvent },
      loadConfig: loadDiscoverConfig,
    });
    loops.push(loop);
    void loop
      .run()
      .catch((err) =>
        log.error({ root, err: err instanceof Error ? err.message : err }, 'sweeper loop crashed'),
      );
  }

  return {
    stop: async () => {
      for (const l of loops) l.stop();
    },
  };
}

/**
 * Child-process entry point. The supervisor spawns:
 *   bun src/api/src/workers/discover/index.ts <root1> [<root2> ...]
 *
 * Connects to Mongo, starts the sweep loops, runs until SIGTERM/SIGINT.
 * folder_id is resolved per root from the registered folders collection.
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
