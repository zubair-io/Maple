import type { AssetId } from '../models/asset';

/**
 * Session-scoped negative cache for thumbnail loads (#2413).
 *
 * An asset whose thumbnail load has already failed once this session — the
 * loader rejected, or silently ran out of branches (no absPath, no apiId)
 * without producing a URL — used to be re-requested on every subsequent
 * `LibraryCache.ensureThumbnailUrl` call: every grid re-render re-fired the
 * same doomed network request forever (the X3F 404 loop from the production
 * editor audit). `ensureThumbnailUrl` now checks this memory as a third
 * short-circuit alongside its URL-cache and in-flight-token checks, and
 * `_loadThumbInternal` records here whenever an attempt settles without a
 * cached URL.
 *
 * Deliberately session-scoped and binary — no TTL or backoff machinery
 * (YAGNI): `LibraryCache.clearAll()` (folder switch / sign-out) clears it,
 * so a later retry of the same id is still possible in a fresh session.
 * Recording is tied to a load attempt actually running, never to queue
 * cancellation (a "Queue cleared" rejection on source switch must not brand
 * the asset as failed — it was merely cancelled).
 */
export class ThumbFailMemory {
  private readonly ids = new Set<AssetId>();

  has(id: AssetId): boolean {
    return this.ids.has(id);
  }

  /**
   * Brand `id` failed — unless `err` is the loader queue's "Queue cleared"
   * cancellation (source switch), which is not a verdict on the asset.
   */
  record(id: AssetId, err?: unknown): void {
    if (err instanceof Error && err.message === 'Queue cleared') return;
    this.ids.add(id);
  }

  clear(): void {
    this.ids.clear();
  }
}
