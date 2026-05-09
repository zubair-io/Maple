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
import * as path from "node:path";
import * as fsNode from "node:fs/promises";
import { ObjectId } from "mongodb";
import { Watcher, type WatchEvent } from "../../indexer/watcher.ts";
import { blankStagesSkeleton } from "../stages/manifest.ts";
import { child } from "../../log.ts";
import { assetsCollection, foldersCollection, getDb, ensureIndexes, closeDb } from "../../db/client.ts";

const log = child("discover");

export interface DiscoverOptions {
  /** Absolute paths to watch. One path per registered folder root. */
  roots: string[];
  /** The folder ObjectId hex that all newly created docs are associated with.
   *  In the full multi-folder system the supervisor passes one discover child
   *  per folder; for now a single instance is sufficient. */
  folderId: string;
  /** File extensions to index (default: the standard SUPPORTED_EXTS set). */
  include?: Set<string>;
  /** Debounce window in ms (default: 250). */
  debounceMs?: number;
}

export interface DiscoverHandle {
  stop: () => Promise<void>;
}

const SUPPORTED_EXTS = new Set([
  ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2",
  ".pef", ".srw", ".x3f", ".3fr", ".mef", ".erf", ".mrw",
  ".jpg", ".jpeg", ".tif", ".tiff", ".heic", ".heif",
]);

/**
 * Exported for integration tests — allows tests to simulate events without
 * waiting for chokidar's polling interval (60s/300s in production config).
 */
export async function handleEvent(event: WatchEvent, folderId: ObjectId): Promise<void> {
  const { kind, absPath, fromPath } = event;
  const coll = await assetsCollection();

  if (kind === "removed") {
    await coll.updateOne(
      { abs_path: absPath },
      { $set: { deleted_at: new Date().toISOString() } },
    );
    log.info({ absPath }, "soft-deleted");
    return;
  }

  if (kind === "renamed" && fromPath) {
    await coll.updateOne(
      { abs_path: fromPath },
      {
        $set: {
          abs_path: absPath,
          filename: path.basename(absPath),
          indexed_at: new Date().toISOString(),
          deleted_at: null,
        },
      },
    );
    log.info({ from: fromPath, to: absPath }, "renamed");
    return;
  }

  // created or modified — upsert with skeleton.
  let stat: Awaited<ReturnType<typeof fsNode.stat>>;
  try {
    stat = await fsNode.stat(absPath);
  } catch {
    log.warn({ absPath }, "stat failed after watch event — skipping");
    return;
  }

  const now = new Date().toISOString();
  await coll.updateOne(
    { folder_id: folderId, filename: path.basename(absPath) },
    {
      $set: {
        abs_path: absPath,
        size: stat.size,
        mtime: stat.mtimeMs,
        indexed_at: now,
        deleted_at: null,
      },
      $setOnInsert: {
        folder_id: folderId,
        filename: path.basename(absPath),
        rating: 0,
        flag: 0,
        color_label: "",
        exif: null,
        maple_id: null,
        sha1_head: null,
        stages: blankStagesSkeleton(),
      },
    },
    { upsert: true },
  );
  log.info({ absPath, kind }, "upserted");
}

/**
 * Start the discover loop. Called by the supervisor in-process (or by tests).
 * Returns a handle that stops the watcher gracefully.
 */
export async function startDiscover(opts: DiscoverOptions): Promise<DiscoverHandle> {
  const folderId = new ObjectId(opts.folderId);
  const include = opts.include ?? SUPPORTED_EXTS;

  const watcher = new Watcher({
    roots: opts.roots,
    debounceMs: opts.debounceMs,
    include,
    onEvent: (event: WatchEvent) => {
      handleEvent(event, folderId).catch((err) => {
        log.error(
          { absPath: event.absPath, err: err instanceof Error ? err.message : err },
          "event handler failed",
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
 *   bun src/api/src/workers/discover/index.ts <folderId> <root1> [<root2> ...]
 *
 * Connects to Mongo, starts the watcher, runs until SIGTERM/SIGINT.
 */
async function main(): Promise<void> {
  const [, , folderId, ...roots] = process.argv;
  if (!folderId || roots.length === 0) {
    process.stderr.write(
      "Usage: bun src/api/src/workers/discover/index.ts <folderId> <root1> [<root2>...]\n",
    );
    process.exit(1);
  }

  await getDb().then(() => ensureIndexes());

  const handle = await startDiscover({ folderId, roots });
  log.info({ folderId, roots }, "discover started");

  async function shutdown(): Promise<void> {
    log.info("shutting down discover");
    await handle.stop();
    await closeDb();
    process.exit(0);
  }

  process.on("SIGTERM", () => {
    shutdown().catch((e) => {
      log.error({ err: e instanceof Error ? e.message : e }, "shutdown error");
      process.exit(1);
    });
  });
  process.on("SIGINT", () => {
    shutdown().catch((e) => {
      log.error({ err: e instanceof Error ? e.message : e }, "shutdown error");
      process.exit(1);
    });
  });
}

// Only run main when executed directly, not when imported by tests.
if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(
      `[discover] fatal: ${e instanceof Error ? e.message : e}\n`,
    );
    process.exit(1);
  });
}
