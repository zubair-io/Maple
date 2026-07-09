// BlobUrlChannel — shared subscribe/notify/ensure machinery for a bounded LRU
// of blob-URL-ish strings keyed by asset id.
//
// `subscribeThumbUrl` and `subscribePreviewUrl` on LibraryCache both need the
// exact same shape: a count-bounded LRU backing store, a per-id subscriber
// registry so a tile's reactive signal dies with the tile (not a central map
// that leaks — see #1363/#1359), an in-flight-load dedup set, and an
// idempotent "ensure this id is loaded, notify subscribers when it lands"
// entry point. This class extracts that shape once so LibraryCache composes
// two instances (thumb + preview) instead of hand-duplicating the machinery.
//
// Reuses ThumbLruCache (blob revocation on evict/clearAll) as the backing
// store — this class only adds the subscriber/loading-set layer on top.

import { ThumbLruCache } from './lru-cache';

export class BlobUrlChannel<TId extends string> {
  private readonly lru: ThumbLruCache;
  private readonly subscribersById = new Map<TId, Set<(url: string | undefined) => void>>();
  private readonly loadingIds = new Set<TId>();

  constructor(maxCount: number) {
    this.lru = new ThumbLruCache(maxCount);
  }

  /** Non-reactive point read of the current cached URL. */
  get(id: TId): string | undefined {
    return this.lru.get(id);
  }

  /** Number of distinct ids with at least one live subscriber. Test hook. */
  get subscriberCount(): number {
    return this.subscribersById.size;
  }

  /**
   * Subscribe to URL changes for `id`. Invokes `cb` immediately with the
   * current URL (warm-cache subscribers paint at once), then again whenever
   * it changes (load completes, or the LRU evicts it → `undefined`). Returns
   * an unsubscribe fn; the id's subscriber set is dropped once empty so the
   * registry stays bounded to what's actually mounted.
   */
  subscribe(id: TId, cb: (url: string | undefined) => void): () => void {
    let subs = this.subscribersById.get(id);
    if (!subs) {
      subs = new Set();
      this.subscribersById.set(id, subs);
    }
    subs.add(cb);
    cb(this.lru.get(id));
    return () => {
      const s = this.subscribersById.get(id);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.subscribersById.delete(id);
    };
  }

  private notify(id: TId, url: string | undefined): void {
    const subs = this.subscribersById.get(id);
    if (subs) for (const cb of subs) cb(url);
  }

  /** Cache a resolved URL for `id` and notify its subscribers. On LRU
   * eviction, the evicted id's subscribers are pushed `undefined` so a
   * still-mounted consumer clears its (now-revoked) blob URL. */
  cacheUrl(id: TId, url: string): void {
    this.lru.set(id, url, (evictedId) => this.notify(evictedId as TId, undefined));
    this.notify(id, url);
  }

  /**
   * Idempotently kick off `loader` for `id` if it isn't already cached or
   * in flight. `loader` resolves with a Blob (cached via `URL.createObjectURL`)
   * or `undefined`/`null` (not ready yet — left uncached so a later
   * `ensure()` call can retry).
   */
  ensure(id: TId, loader: (id: TId) => Promise<Blob | null | undefined>): void {
    if (this.lru.get(id) !== undefined) return;
    if (this.loadingIds.has(id)) return;
    this.loadingIds.add(id);
    void loader(id)
      .then((blob) => {
        if (blob) this.cacheUrl(id, URL.createObjectURL(blob));
      })
      .catch((err) => {
        console.warn('[state] blob load failed for', id, err);
      })
      .finally(() => this.loadingIds.delete(id));
  }

  /** Snapshot as a plain Map, e.g. for an Angular signal. */
  toMap(): Map<TId, string> {
    return this.lru.toMap() as Map<TId, string>;
  }

  /** Revoke every cached blob URL, push `undefined` to all subscribers, and
   * empty both the LRU and the subscriber registry. Hard-reset path
   * (sign-out / forced wipe) — normal browsing evicts gradually via the LRU. */
  clearAll(): void {
    this.lru.clearAll();
    for (const subs of this.subscribersById.values()) for (const cb of subs) cb(undefined);
    this.subscribersById.clear();
    // Without this, an id whose `loader` promise is still in flight at the
    // moment of a hard reset stays stuck in `loadingIds` forever (the
    // in-flight promise's `.finally()` deletes it later, but a subsequent
    // `ensure()` call in between is a no-op until then) — so a fresh `ensure()`
    // for that same id right after `clearAll()` would be silently ignored.
    this.loadingIds.clear();
  }
}
