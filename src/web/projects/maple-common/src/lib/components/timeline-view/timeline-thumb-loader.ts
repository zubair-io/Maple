// Bounded thumbnail request queue for TimelineView (#2219).
//
// Why this exists: TimelineView used to call the thumb endpoint once per row
// with no bound, so a PAGE_SIZE=200 page put 200 requests into the browser's
// connection pool at once. The Self Hosted API is served by `Bun.serve`, which
// is HTTP/1.1-only, so the browser caps the origin at 6 connections — 194 of
// those thumb requests sat queued and every unrelated /api/* call (the next
// search page, /api/folders, a token refresh) head-of-line blocked behind
// them. Through Cloudflare the browser negotiates HTTP/2 and multiplexes, which
// is the whole reason the hosted deployment felt faster than the LAN.
//
// The bound is 4, matching `LibraryCache.MAX_CONCURRENT_THUMB_LOADS` — the
// queue the asset grid has always used, and which TimelineView was the only
// grid surface to bypass. It leaves 2 of the 6 HTTP/1.1 connections free for
// everything else on the page.
//
// Angular-free and DI-free (like `timeline-view.utils.ts`) so the concurrency
// behaviour is unit-testable without TestBed.

/** Concurrent thumb requests allowed against the origin at any moment. */
export const MAX_CONCURRENT_THUMB_LOADS = 4;

interface QueuedThumb {
  absPath: string;
  /** `monthKey(year, month)` of the section this photo belongs to, so work for
   * a month that scrolls back out of view can be dropped un-started. */
  monthKey: string;
  /** Resolves when this entry finishes, fails, or is dropped. */
  settled: Promise<void>;
  resolve: () => void;
}

const ignore = (): void => {};

export class TimelineThumbLoader {
  /** `abs_path` → `blob:` URL for every thumb loaded this session. Handed to
   * `foldPage` so a re-fold re-attaches URLs already in hand. */
  readonly urls = new Map<string, string>();

  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly queue: QueuedThumb[] = [];
  private readonly queuedByPath = new Map<string, QueuedThumb>();
  private active = 0;

  /**
   * @param fetchThumb Issues the actual request for one photo's thumbnail.
   * @param onLoaded Called once per successful load so the caller can project
   *   the URL into its render state.
   */
  constructor(
    private readonly fetchThumb: (absPath: string) => Promise<string>,
    private readonly onLoaded: (absPath: string, url: string) => void,
  ) {}

  /**
   * Request `absPath`'s thumbnail, subject to the concurrency bound. Resolves
   * once the request finishes, fails, or is dropped — callers use it only to
   * sequence, never to read the URL (that arrives via `onLoaded`).
   *
   * Idempotent per path: an already-loaded, in-flight, or still-queued photo
   * shares the existing attempt rather than adding a second request.
   */
  load(absPath: string, monthKey: string): Promise<void> {
    if (this.urls.has(absPath)) return Promise.resolve();

    const inFlight = this.inFlight.get(absPath);
    if (inFlight) return inFlight.then(ignore, ignore);

    const alreadyQueued = this.queuedByPath.get(absPath);
    if (alreadyQueued) return alreadyQueued.settled;

    let resolve!: () => void;
    const settled = new Promise<void>((r) => {
      resolve = r;
    });
    const entry: QueuedThumb = { absPath, monthKey, settled, resolve };
    this.queue.push(entry);
    this.queuedByPath.set(absPath, entry);
    this._pump();
    return settled;
  }

  /**
   * Drop not-yet-started work for `monthKey`. Called when the visibility
   * observer reports that month left the viewport, so scrolling fast past ten
   * months doesn't make the reader wait behind thumbnails for nine of them.
   * Requests already in flight are left to finish — cancelling them would
   * discard a response the server has already paid to render.
   */
  dropMonth(monthKey: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const entry = this.queue[i]!;
      if (entry.monthKey !== monthKey) continue;
      this.queue.splice(i, 1);
      this.queuedByPath.delete(entry.absPath);
      entry.resolve();
    }
  }

  /** Abandon every queued request — the scope or filter changed, so nothing
   * still waiting is wanted. `urls` is kept: the blob URLs are owned by
   * `FilesystemBrowseService`'s own cache and stay valid until it revokes
   * them, so a photo still in view after the change needs no refetch. */
  abandonQueued(): void {
    for (const entry of this.queue) {
      this.queuedByPath.delete(entry.absPath);
      entry.resolve();
    }
    this.queue.length = 0;
  }

  private _pump(): void {
    while (this.active < MAX_CONCURRENT_THUMB_LOADS) {
      const entry = this.queue.shift();
      if (!entry) return;
      this.queuedByPath.delete(entry.absPath);
      this._start(entry);
    }
  }

  private _start(entry: QueuedThumb): void {
    this.active++;
    const request = this.fetchThumb(entry.absPath);
    this.inFlight.set(entry.absPath, request);
    void request
      .then((url) => {
        this.urls.set(entry.absPath, url);
        this.onLoaded(entry.absPath, url);
      })
      .catch(ignore) // Silent — the gradient placeholder stays and a later scroll retries.
      .finally(() => {
        this.inFlight.delete(entry.absPath);
        this.active--;
        entry.resolve();
        this._pump();
      });
  }
}
