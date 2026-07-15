/**
 * Server-wide concurrency gate for ON-DEMAND (request-path) preview
 * regeneration — `GET /api/preview/:slug/*` (`routes/library/preview.ts`)
 * and `GET /api/fs/preview` (`routes/fs-previews.ts`) both call
 * `generatePreview` synchronously on a cache miss. Unlike the background
 * `preview` stage (`workers/stages/preview.ts`), which already bounds its
 * own decode+AVIF-encode work via `defineStage`'s per-tick `concurrency`
 * dispatch pool, nothing bounded how many of these on-demand calls could run
 * at once — a burst of near-simultaneous cache misses (opening a large NAS
 * folder in Browse right after the #2006 AVIF/path-key migration, before the
 * background stage has caught every asset up) could pile up unboundedly,
 * competing with live interactive requests for CPU/IO (#2012, part of the
 * #1993 preview-unification epic).
 *
 * Judgment call (see PR description): this reuses the EXISTING `preview`
 * stage's `concurrency` setting — already a DB-backed, operator-visible
 * control on Settings → Workers (`worker_config` collection) — as the cap
 * for this gate, rather than introducing a brand new setting/UI. Both knobs
 * answer the same physical question ("how many preview-generation jobs may
 * run at once"), just for two different trigger sources (poll-claimed batch
 * vs. HTTP request), so one number an operator already understands governs
 * both. `routes-main.ts`'s generic `PATCH /:name/config` handler calls
 * `previewOndemandLimiter().setLimit(...)` live whenever the `preview`
 * stage's concurrency is saved — no restart needed, matching the FFI-pool
 * live-resize precedent (`ffi-pool-bootstrap.ts`).
 *
 * Lives in the API process (not the worker child process — see
 * `routes-main.ts`'s module doc on that split), so it cannot share an
 * in-memory object with the stage's own dispatch pool; it independently
 * seeds itself from the same persisted `worker_config.preview.concurrency`
 * value on first use, lazily (mirrors the API process's existing "nothing to
 * warm at boot" convention for the FFI pool — see `index.ts`).
 */

import { workerConfigCollection } from '../db/client.ts';
import { WorkerConfigRepo } from '../workers/worker-config.repo.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('preview-ondemand-limiter');

/** Mirrors `preview` stage's `defaults.concurrency` in
 * `workers/stages/preview.ts` — used only until the first successful DB
 * read (fresh install, or the DB is briefly unreachable). */
export const DEFAULT_ONDEMAND_LIMIT = 2;

class PreviewOndemandLimiter {
  private limit = DEFAULT_ONDEMAND_LIMIT;
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];
  private seedPromise: Promise<void> | null = null;

  /** Current cap. Exposed for tests/diagnostics. */
  currentLimit(): number {
    return this.limit;
  }

  /** Live-adjust the cap (e.g. from the `PATCH /:name/config` hook). A raise
   * immediately drains any queued waiters up to the new cap; a lower cap
   * just stops admitting new work above it — nothing in flight is aborted. */
  setLimit(n: number): void {
    if (!Number.isFinite(n) || n < 1) return;
    this.limit = Math.floor(n);
    this.drain();
  }

  private drain(): void {
    while (this.inFlight < this.limit && this.queue.length > 0) {
      this.inFlight++;
      const next = this.queue.shift();
      next?.();
    }
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.limit) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.drain();
  }

  /**
   * Run `fn` once a permit is free, queuing (FIFO) when the cap is already
   * saturated. Every caller waits its turn and eventually runs — this is a
   * throttle, not a rejector, matching the ticket's "queue the rest" scope
   * (no queue-depth cap or timeout: a queued waiter is just a tiny pending
   * closure, and bounding queue depth is a separate concern this ticket
   * doesn't call for).
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureSeeded();
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Seed `limit` from the persisted `preview` stage concurrency on first
   * use only — avoids a DB round-trip on every on-demand request. Best
   * effort: a failure (DB unreachable) just leaves the built-in default in
   * place; `setLimit` from the live PATCH hook still applies going forward. */
  private ensureSeeded(): Promise<void> {
    if (!this.seedPromise) {
      this.seedPromise = (async () => {
        try {
          const repo = new WorkerConfigRepo(await workerConfigCollection());
          const cfg = await repo.load('preview');
          if (cfg) this.setLimit(cfg.concurrency);
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : err },
            'could not seed on-demand limit from worker_config — using built-in default',
          );
        }
      })();
    }
    return this.seedPromise;
  }
}

let _limiter: PreviewOndemandLimiter | null = null;

/** Process-wide limiter. Lazily constructed on first call. */
export function previewOndemandLimiter(): PreviewOndemandLimiter {
  if (!_limiter) _limiter = new PreviewOndemandLimiter();
  return _limiter;
}

/** Test-only: drop the singleton so a fresh, unseeded limiter is built next
 * call. Mirrors `_resetFfiPoolForTests` in `ffi/ffi-pool.ts`. */
export function _resetPreviewOndemandLimiterForTests(): void {
  _limiter = null;
}

export type { PreviewOndemandLimiter };
