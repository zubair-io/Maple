/**
 * Spawning the worker tier, and keeping it alive.
 *
 * The worker tier runs as a niced child process so the HTTP event loop can
 * never be starved or crashed by indexer or enrichment load — the child owns
 * stages, discover, the FFI pool, enrichment, the job runner and the import
 * runner, and a crash there is a respawn rather than an outage.
 *
 * The respawn backoff is the part worth having in one place. A worker that dies
 * almost immediately is crash-looping — a poison asset that aborts the tier on
 * boot (#897), or a bad deploy — and a flat one-second respawn just hammers the
 * box and the log pipeline. The delay grows on each rapid death up to a cap and
 * resets once a worker has run healthily, so a one-off crash still comes back
 * promptly and a loop backs off.
 *
 * Extracted from `index.ts` when the cutover (#3752) pushed that file past its
 * headroom threshold. Nothing about the behaviour changed; the supervisor
 * simply owns the handle it was already keeping in a module-level binding.
 */

import { child as childLogger } from '../log.ts';
import {
  ChildProcessWorker,
  childScriptPath,
  DEFAULT_NATIVE_CHILD_NICE,
} from './child-process-worker.ts';

const log = childLogger('server');

const RESPAWN_MIN_MS = 1000;
const RESPAWN_MAX_MS = 30_000;
/** Uptime after which a death counts as one-off rather than a crash loop. */
const HEALTHY_UPTIME_MS = 60_000;

let child: ChildProcessWorker | null = null;
let respawnMs = RESPAWN_MIN_MS;
let stopped = false;

/**
 * Starts the worker tier, unless the operator has turned it off.
 *
 * `workerEntry` is the URL of the module that resolves the child's entry point
 * — the caller passes its own `import.meta.url` so the path resolves the same
 * way it did when this lived in `index.ts`.
 */
export function startWorkerSupervisor(workerEntry: string): void {
  stopped = false;
  if (process.env.MAPLE_INDEXER_AUTOSTART === '0') {
    log.info('Worker process disabled (MAPLE_INDEXER_AUTOSTART=0)');
    return;
  }
  spawn(workerEntry);
}

/** Terminates the worker and stops respawning it. Idempotent. */
export function stopWorkerSupervisor(): void {
  stopped = true;
  child?.terminate();
  child = null;
}

function spawn(workerEntry: string): void {
  if (stopped) return;
  try {
    const spawnedAt = Date.now();
    const worker = new ChildProcessWorker(
      childScriptPath(workerEntry, './workers/worker-main.ts'),
      { nice: DEFAULT_NATIVE_CHILD_NICE, label: 'worker' },
    );
    worker.addEventListener('error', (event) => {
      const uptimeMs = Date.now() - spawnedAt;
      // Ran healthily then died → one-off, reset the backoff. Died fast → grow it.
      if (uptimeMs >= HEALTHY_UPTIME_MS) respawnMs = RESPAWN_MIN_MS;
      const delayMs = respawnMs;
      respawnMs = Math.min(respawnMs * 2, RESPAWN_MAX_MS);
      log.error(
        { msg: event.message, uptimeMs, respawnInMs: delayMs },
        'worker process died — respawning',
      );
      child = null;
      if (!stopped) setTimeout(() => spawn(workerEntry), delayMs);
    });
    child = worker;
    log.info('worker process spawned');
  } catch (err) {
    log.error({ err }, 'failed to spawn worker process');
  }
}
