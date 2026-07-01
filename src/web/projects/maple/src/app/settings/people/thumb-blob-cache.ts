// ThumbBlobCache — bearer-gated thumbnail blob cache used by the People
// surface. Extracted from PeopleComponent so the component itself stays
// focused on UI state + flow control; the bearer-token plumbing and the
// owned/borrowed URL lifecycle live here.
//
// Direct `<img src="/api/assets/:id/thumb">` bypasses Angular's HttpClient
// and so doesn't get the Bearer token from `authInterceptor` — the API
// would 401. We fetch via HttpClient (interceptor attaches the bearer) and
// hand the template a `blob:` URL the browser can render with no extra
// auth. The absPath path delegates to {@link FilesystemBrowseService} so
// the URL is shared with /browse's grid (same `/api/fs/thumb?path=…`
// URL → same in-memory blob, same browser HTTP cache entry).
//
// Lifecycle:
//   * URLs returned from `FilesystemBrowseService.getThumbBlobUrl` are
//     owned by that singleton — we deliberately do NOT revoke them.
//   * URLs we minted via `URL.createObjectURL` (the orphan-cover fallback)
//     are tracked in `ownedBlobUrls` and revoked by {@link destroy}.
//
// Usage:
//   const cache = new ThumbBlobCache(api, fsBrowse);
//   cache.ensure(key, address, absPath, apiAssetId);
//   const url = cache.url(absPath);
//   ngOnDestroy() { cache.destroy(); }

import { Signal, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { BunApiBackendService, FilesystemBrowseService, type LibrarySource } from '@maple-common';

export class ThumbBlobCache {
  /** Cache key (`absPath` when present, otherwise `apiId:<id>`) → `blob:`
   * URL of the fetched thumbnail JPEG. Exposed as a `Signal` so consumers
   * can `computed`/`effect` off it. */
  private readonly _blobs = signal<ReadonlyMap<string, string>>(new Map());

  /** Cache keys currently being fetched — prevents duplicate round-trips
   * when the template re-evaluates a binding before the response lands. */
  private readonly inflight = new Set<string>();

  /** Blob URLs we minted via `URL.createObjectURL` (the api-id fallback).
   * Tracked so we can revoke on destroy and not leak. */
  private readonly ownedUrls = new Set<string>();

  constructor(
    private readonly api: BunApiBackendService,
    private readonly fsBrowse: FilesystemBrowseService,
    private readonly librarySource?: LibrarySource,
  ) {}

  /** Read-only view of the cache. Template bindings should read through
   * the {@link url} helper rather than touching this directly. */
  get blobs(): Signal<ReadonlyMap<string, string>> {
    return this._blobs.asReadonly();
  }

  /** Build a stable cache key for a cover-shaped record.
   * Prefer `coverAddress` (slug:relPath) for cache coherence with /browse's
   * LibrarySource thumb path; fall back to `absPath` for legacy installs;
   * last resort `apiId:` when the cover asset doc was deleted. */
  static coverKey(p: {
    coverAddress?: string | null;
    coverAbsPath: string | null;
    coverAssetId: string | null;
  }): string | null {
    if (p.coverAddress) return p.coverAddress;
    if (p.coverAbsPath) return p.coverAbsPath;
    if (p.coverAssetId) return `apiId:${p.coverAssetId}`;
    return null;
  }

  /** Idempotently load the thumb URL for `cacheKey` (the dedup key).
   *
   * Resolution order (routed on the EXPLICIT args, never sniffed from the key):
   *   1. `address` (`slug:relPath`) present → `LibrarySource.thumbUrl`
   *      (→ `/api/thumb/:slug/*`, immutable-cached HTTP URL; no blob round-trip).
   *   2. `absPath` present → `FilesystemBrowseService.getThumbBlobUrl`
   *      (legacy `/api/fs/thumb?path=…` blob, shared with /browse).
   *   3. `apiAssetId` → `api.getThumb` blob (orphan-cover fallback).
   */
  ensure(
    cacheKey: string | null,
    address: string | null,
    absPath: string | null,
    apiAssetId: string | null,
  ): void {
    if (!cacheKey) return;
    if (this.inflight.has(cacheKey)) return;
    // `untracked` so adding a new blob URL doesn't re-trigger any caller
    // effect — only the upstream signals (people / selected) should.
    if (untracked(this._blobs).has(cacheKey)) return;
    this.inflight.add(cacheKey);

    let promise: Promise<{ url: string; owned: boolean }>;

    // Preferred M2 path: an explicit slug:relPath address via LibrarySource.
    // Route on the explicit `address` arg — never sniff `cacheKey.includes(':')`,
    // which misclassifies Windows paths (`C:\…`) and POSIX names containing ':'.
    if (this.librarySource && address) {
      const [slug, ...rest] = address.split(':');
      const relPath = rest.join(':');
      promise = this.librarySource
        .thumbBlob({ slug: slug!, relPath })
        .then((blob) => {
          if (!blob) throw new Error('empty thumb blob');
          return { url: URL.createObjectURL(blob), owned: true };
        });
    } else if (absPath) {
      // Legacy path: fetch via /api/fs/thumb + bearer token, cache as blob.
      // Match the size /browse asks for (512) so the same absPath key
      // resolves to the same blob entry on both surfaces.
      promise = this.fsBrowse.getThumbBlobUrl(absPath, 512).then((url) => ({ url, owned: false }));
    } else if (apiAssetId) {
      promise = firstValueFrom(this.api.getThumb(apiAssetId)).then((b) => ({
        url: URL.createObjectURL(b),
        owned: true,
      }));
    } else {
      promise = Promise.reject(new Error('no asset reference'));
    }

    promise
      .then(({ url, owned }) => {
        this.inflight.delete(cacheKey);
        if (owned) this.ownedUrls.add(url);
        const next = new Map(untracked(this._blobs));
        next.set(cacheKey, url);
        this._blobs.set(next);
      })
      .catch(() => {
        this.inflight.delete(cacheKey);
      });
  }

  /** Returns the blob URL for `cacheKey` or `null` while the fetch is in
   * flight (the template falls back to a placeholder). */
  url(cacheKey: string | null): string | null {
    if (!cacheKey) return null;
    return this._blobs().get(cacheKey) ?? null;
  }

  /** Revoke every blob URL we own. Idempotent. */
  destroy(): void {
    for (const url of this.ownedUrls) URL.revokeObjectURL(url);
    this.ownedUrls.clear();
  }
}
