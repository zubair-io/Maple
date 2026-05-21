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
//   cache.ensure(absPath, absPath, apiAssetId);
//   const url = cache.url(absPath);
//   ngOnDestroy() { cache.destroy(); }

import { Signal, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { BunApiBackendService, FilesystemBrowseService } from '@maple-common';

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
  ) {}

  /** Read-only view of the cache. Template bindings should read through
   * the {@link url} helper rather than touching this directly. */
  get blobs(): Signal<ReadonlyMap<string, string>> {
    return this._blobs.asReadonly();
  }

  /** Build a stable cache key for a cover-shaped record. Prefer `absPath`
   * so the blob URL is shared with /browse; fall back to a synthetic
   * `apiId:` key when the cover asset doc was deleted. */
  static coverKey(p: { coverAbsPath: string | null; coverAssetId: string | null }): string | null {
    if (p.coverAbsPath) return p.coverAbsPath;
    if (p.coverAssetId) return `apiId:${p.coverAssetId}`;
    return null;
  }

  /** Idempotently load the blob URL for a thumb keyed by `cacheKey`. When
   * `absPath` is set we delegate to `FilesystemBrowseService.getThumbBlobUrl`
   * (singleton cache, shared with /browse). Otherwise we fall back to the
   * api-id endpoint, which doesn't share with /browse but covers the
   * orphan case where the asset doc has been deleted. */
  ensure(cacheKey: string | null, absPath: string | null, apiAssetId: string | null): void {
    if (!cacheKey) return;
    if (this.inflight.has(cacheKey)) return;
    // `untracked` so adding a new blob URL doesn't re-trigger any caller
    // effect — only the upstream signals (people / selected) should.
    if (untracked(this._blobs).has(cacheKey)) return;
    this.inflight.add(cacheKey);

    // Match the size /browse asks for (512) so the cache key (absPath)
    // resolves to the same blob entry — otherwise whichever route loads
    // first wins and the other gets the wrong-resolution thumb.
    const promise: Promise<{ url: string; owned: boolean }> = absPath
      ? this.fsBrowse.getThumbBlobUrl(absPath, 512).then((url) => ({ url, owned: false }))
      : apiAssetId
        ? firstValueFrom(this.api.getThumb(apiAssetId)).then((b) => ({
            url: URL.createObjectURL(b),
            owned: true,
          }))
        : Promise.reject(new Error('no asset reference'));

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
