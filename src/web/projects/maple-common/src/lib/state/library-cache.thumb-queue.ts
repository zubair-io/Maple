// Bounded thumbnail load queue for LibraryCache.
//
// Split out of `library-cache.service.ts` (which sits against the 600-line
// hard budget) so the concurrency behaviour is unit-testable without TestBed,
// the same way `timeline-thumb-loader.ts` is for TimelineView.
//
// The bound is 4 because the Self Hosted API is served by `Bun.serve`, which is
// HTTP/1.1-only: the browser caps the origin at 6 connections, so an unbounded
// grid would head-of-line block every other `/api/*` call behind a wall of
// thumbnails (#2219). Four leaves two connections for everything else.
//
// `cancel` is what keeps scrolling responsive. The browse grid virtualizes, so
// a tile that scrolls out of view is destroyed — but its queued request used to
// survive and still spend one of the four connections. Scrolling through a
// large folder therefore left the thumbnails you are actually looking at
// waiting behind hundreds of requests for rows already passed. Dropping
// not-yet-started work on unmount mirrors `TimelineThumbLoader.dropMonth`.

/** Concurrent thumb requests allowed against the origin at any moment. */
export const MAX_CONCURRENT_THUMB_LOADS = 4;

/**
 * Rejection message for work dropped by {@link ThumbLoadQueue.clear}. Expected
 * control flow (a source or folder switch), not a failure: `ThumbFailMemory`
 * refuses to brand the asset on it, and the loader's catch stays quiet rather
 * than logging one warning per queued thumbnail. Shared so those three call
 * sites cannot drift apart on a string literal.
 */
export const QUEUE_CLEARED_MESSAGE = 'Queue cleared';

interface QueuedLoad {
  id: string;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class ThumbLoadQueue {
  private readonly queue: QueuedLoad[] = [];
  private inFlight = 0;

  /** Not-yet-started entries. Test hook. */
  get depth(): number {
    return this.queue.length;
  }

  /** Entries currently running. Test hook. */
  get active(): number {
    return this.inFlight;
  }

  /**
   * Queue `run` for `id`, subject to the concurrency bound. The returned
   * promise settles when the load finishes, fails, or is cancelled — callers
   * use it only to sequence, never to read a URL.
   */
  enqueue(id: string, run: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ id, run, resolve, reject });
      this._pump();
    });
  }

  /**
   * Drop `id`'s queued work if it has not started yet; returns whether
   * anything was dropped. Already-running loads are left to finish —
   * cancelling one would discard a response the server has already paid to
   * render.
   *
   * Resolves (never rejects) the waiter: a cancelled load was never attempted,
   * so it must not reach `ThumbFailMemory` and get branded unretryable.
   */
  cancel(id: string): boolean {
    const index = this.queue.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    const [entry] = this.queue.splice(index, 1);
    entry!.resolve();
    return true;
  }

  /**
   * Abandon everything still queued — the source or folder changed, so nothing
   * waiting is wanted. Rejects with the `Queue cleared` sentinel that
   * `ThumbFailMemory.record` ignores, so a cancelled asset stays retryable.
   */
  clear(): void {
    const dropped = this.queue.splice(0, this.queue.length);
    for (const entry of dropped) entry.reject(new Error(QUEUE_CLEARED_MESSAGE));
  }

  private _pump(): void {
    while (this.inFlight < MAX_CONCURRENT_THUMB_LOADS) {
      const next = this.queue.shift();
      if (!next) return;
      this.inFlight++;
      void next
        .run()
        .then(next.resolve, next.reject)
        .finally(() => {
          this.inFlight--;
          this._pump();
        });
    }
  }
}
