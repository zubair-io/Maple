/**
 * Indexer task queue.
 *
 * Architecture:
 *   - In-memory queue (EventEmitter-based) for low-latency dispatch.
 *   - MongoDB-backed persistence for tasks that survive restarts.
 *   - Configurable worker concurrency (MAPLE_INDEXER_WORKERS, default 2).
 *   - Progress events broadcast via a simple EventEmitter for SSE.
 *
 * Tasks are processed in FIFO order per kind. Tasks with the same
 * (kind, key) are deduplicated before enqueuing.
 */

import { EventEmitter } from "node:events";
import type { TaskKind, IndexerTaskDoc } from "../db/schema.ts";

// ---------------------------------------------------------------------------
// Progress event bus — used by the SSE route.
// ---------------------------------------------------------------------------

export interface ProgressEvent {
  task_id: string;
  kind: TaskKind;
  status: "pending" | "processing" | "done" | "failed";
  detail?: string;
}

export const progressBus = new EventEmitter();
progressBus.setMaxListeners(200); // allow many SSE subscribers

// ---------------------------------------------------------------------------
// In-memory queue entry
// ---------------------------------------------------------------------------

interface QueueEntry {
  id: string;
  kind: TaskKind;
  payload: Record<string, unknown>;
  /** Dedup key — tasks with the same dedup key are not enqueued twice. */
  dedupKey: string;
}

const _queue: QueueEntry[] = [];
const _inFlight = new Set<string>(); // task IDs currently being processed
const _dedupKeys = new Set<string>(); // active dedup keys

const MAX_WORKERS = Number(process.env.MAPLE_INDEXER_WORKERS ?? 2);
let _activeWorkers = 0;

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Enqueue a task. Returns the task ID (a hex timestamp + random suffix).
 * Silently deduplicates tasks with the same (kind + canonical payload).
 */
export async function enqueueTask(
  kind: TaskKind,
  payload: Record<string, unknown>
): Promise<string> {
  const dedupKey = `${kind}:${JSON.stringify(payload)}`;
  if (_dedupKeys.has(dedupKey)) {
    // Already queued — return a placeholder ID.
    return "dedup:" + dedupKey;
  }

  const id = generateId();
  _queue.push({ id, kind, payload, dedupKey });
  _dedupKeys.add(dedupKey);

  // Persist to MongoDB if connected.
  await persistTask(id, kind, payload).catch((e) => {
    // Non-fatal — in-memory queue is authoritative.
    console.warn("[indexer] could not persist task to DB:", e.message);
  });

  emit(id, kind, "pending");
  drainQueue();
  return id;
}

// ---------------------------------------------------------------------------
// Drain / worker loop
// ---------------------------------------------------------------------------

function drainQueue(): void {
  while (_activeWorkers < MAX_WORKERS && _queue.length > 0) {
    const entry = _queue.shift()!;
    _dedupKeys.delete(entry.dedupKey);
    _inFlight.add(entry.id);
    _activeWorkers++;
    processTask(entry).finally(() => {
      _inFlight.delete(entry.id);
      _activeWorkers--;
      drainQueue(); // pick up next task
    });
  }
}

async function processTask(entry: QueueEntry): Promise<void> {
  emit(entry.id, entry.kind, "processing");
  await updateTaskStatus(entry.id, "processing").catch(() => {});

  try {
    await runTask(entry.kind, entry.payload, entry.id);
    emit(entry.id, entry.kind, "done");
    await updateTaskStatus(entry.id, "done").catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[indexer] task ${entry.id} (${entry.kind}) failed:`, msg);
    emit(entry.id, entry.kind, "failed", msg);
    await updateTaskStatus(entry.id, "failed", msg).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Task dispatcher
// ---------------------------------------------------------------------------

async function runTask(
  kind: TaskKind,
  payload: Record<string, unknown>,
  taskId: string
): Promise<void> {
  switch (kind) {
    case "scan_folder":
      await runScanFolder(payload, taskId);
      break;
    case "gen_thumb":
      await runGenThumb(payload, taskId);
      break;
    case "extract_exif":
      await runExtractExif(payload, taskId);
      break;
    default:
      throw new Error(`Unknown task kind: ${kind}`);
  }
}

// ---------------------------------------------------------------------------
// Task implementations
// ---------------------------------------------------------------------------

async function runScanFolder(
  payload: Record<string, unknown>,
  taskId: string
): Promise<void> {
  const { folder_id, path: folderPath } = payload as {
    folder_id: string;
    path: string;
  };

  const { scanFolder } = await import("./scanner.ts");
  const count = await scanFolder(folder_id, folderPath as string, (file) => {
    emit(taskId, "scan_folder", "processing", `Scanning: ${file}`);
  });

  console.log(`[indexer] scan_folder done: ${count} files in ${folderPath}`);
}

async function runGenThumb(
  payload: Record<string, unknown>,
  _taskId: string
): Promise<void> {
  const { asset_id, abs_path } = payload as {
    asset_id: string;
    abs_path: string;
  };

  const { generateThumb } = await import("./thumbnailer.ts");
  await generateThumb(asset_id, abs_path);
}

async function runExtractExif(
  payload: Record<string, unknown>,
  _taskId: string
): Promise<void> {
  const { asset_id, abs_path } = payload as {
    asset_id: string;
    abs_path: string;
  };

  const { extractAndStoreExif } = await import("./exif.ts");
  await extractAndStoreExif(asset_id, abs_path);
}

// ---------------------------------------------------------------------------
// MongoDB persistence helpers (non-fatal if DB is unavailable)
// ---------------------------------------------------------------------------

async function persistTask(
  id: string,
  kind: TaskKind,
  payload: Record<string, unknown>
): Promise<void> {
  const { indexerQueueCollection } = await import("../db/client.ts");
  const coll = await indexerQueueCollection();
  const now = new Date().toISOString();
  const doc: Omit<IndexerTaskDoc, "_id"> = {
    kind,
    payload,
    status: "pending",
    error: null,
    created_at: now,
    updated_at: now,
  };
  // Use id as the _id by storing it in payload — MongoDB will assign _id.
  await coll.insertOne({ ...doc, _id: { toHexString: () => id } as never });
}

async function updateTaskStatus(
  _id: string,
  status: IndexerTaskDoc["status"],
  error?: string
): Promise<void> {
  // Best-effort update — no-op if DB isn't available.
  const { indexerQueueCollection } = await import("../db/client.ts");
  const coll = await indexerQueueCollection();
  await coll.updateOne(
    { "payload._task_id": _id },
    {
      $set: {
        status,
        error: error ?? null,
        updated_at: new Date().toISOString(),
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(
  id: string,
  kind: TaskKind,
  status: ProgressEvent["status"],
  detail?: string
): void {
  const ev: ProgressEvent = { task_id: id, kind, status, detail };
  progressBus.emit("progress", ev);
}

function generateId(): string {
  return Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
}

/** Queue stats for health/debug endpoints. */
export function queueStats(): {
  pending: number;
  in_flight: number;
  active_workers: number;
  max_workers: number;
} {
  return {
    pending: _queue.length,
    in_flight: _inFlight.size,
    active_workers: _activeWorkers,
    max_workers: MAX_WORKERS,
  };
}
