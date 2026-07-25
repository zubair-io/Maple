// FilesystemBrowseService — wraps the auth-gated /api/fs/* endpoints.
//
// Phase B of the "browse by walking the filesystem" feature: the registered
// libraries from /api/folders are still the roots of the sidebar tree, but
// once the user opens one we walk the directory tree directly via
//   GET /api/fs/dir-fast?path=<abs>  → sub-dirs + RAW images at one level
//   GET /api/fs/thumb?path=<abs>     → image/avif bytes at the fixed thumb
//                                      tier (cached on disk by API)
// instead of going through Mongo-keyed /api/folders/{id}/assets.
//
// `/dir-fast` is the pure-filesystem variant (no EXIF / asset_id / sidecars).
// The Apple File Provider extension and the iOS/macOS cloud-source browse
// continue to use `/api/fs/dir`, which returns the enriched response they
// depend on (FP items are keyed by Mongo asset ID).
//
// Both endpoints sit behind requireAuth on the server. /api/fs/dir-fast is
// JSON and rides through HttpClient (so the auth interceptor attaches the
// bearer). /api/fs/thumb returns image bytes — we fetch via HttpClient too
// and turn the Blob into an object URL so the bearer-less <img src=...> works.

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpEventType, HttpParams } from '@angular/common/http';
import { Observable, firstValueFrom, lastValueFrom, filter, map } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

/**
 * Download progress for a byte fetch. `total` is the known size in bytes
 * (Content-Length, or a caller-supplied FS-listing `size` fallback) or
 * `null` when the length is genuinely unknown — keep the bar indeterminate
 * in that case.
 */
export interface DownloadProgress {
  loaded: number;
  total: number | null;
}

export interface FsDirEntry {
  /** Basename. */
  name: string;
  /** Absolute, symlink-resolved path on disk. */
  path: string;
  /** ISO-8601 mtime from the server. */
  mtime: string;
}

export interface FsImageEntry extends FsDirEntry {
  size: number;
  /** Lowercase extension, no dot. */
  ext: string;
  /** True when this entry is a video container (e.g. .mov, .mp4). */
  isVideo?: boolean;
}

export interface FsDirListing {
  /** Resolved absolute path of the listed directory. */
  path: string;
  /** Parent directory, or null at MAPLE_ROOTS. */
  parent: string | null;
  dirs: FsDirEntry[];
  images: FsImageEntry[];
}

@Injectable({ providedIn: 'root' })
export class FilesystemBrowseService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /**
   * Cache of `path → Promise<blob:url>`. Promises live here (not just URLs)
   * so concurrent requests for the same thumbnail share a single network
   * round-trip. The Promise resolves to a `blob:` URL backed by an
   * `image/avif` blob; bind it to an <img> via [src].
   */
  private readonly thumbBlobCache = new Map<string, Promise<string>>();

  /** GET /api/fs/dir-fast?path=<abs>. Returns subdirs + RAW images at one
   * level. Pure filesystem — no Mongo round-trip, no EXIF, no sidecars. */
  listDir(absPath: string): Observable<FsDirListing> {
    const params = new HttpParams().set('path', absPath);
    return this.http.get<FsDirListing>(`${this.base}/fs/dir-fast`, { params });
  }

  /** GET /api/fs/roots — the MAPLE_ROOTS jail roots (default `["/"]`). A
   * picker starts browsing here instead of at a registered library. */
  roots(): Observable<string[]> {
    return this.http.get<{ roots: string[] }>(`${this.base}/fs/roots`).pipe(map((r) => r.roots));
  }

  /**
   * Plain URL form for cases where the bearer isn't required (e.g. logging,
   * or an open-Web public deployment). NOT what `<img src>` uses today —
   * use {@link getThumbBlobUrl} for that, since /api/fs/thumb is auth-gated
   * and `<img>` requests bypass the HttpClient interceptor.
   *
   * No size parameter: `/api/fs/thumb` serves a single fixed tier (#2220). It
   * used to accept `?size=` and ignore it — one cache file per source with an
   * mtime-only freshness check meant any other size was served the 512 px file
   * anyway. For the display-resolution tier use the preview endpoint.
   */
  thumbUrl(absPath: string): string {
    const q = new URLSearchParams({ path: absPath });
    return `${this.base}/fs/thumb?${q.toString()}`;
  }

  /**
   * Fetch a thumbnail AVIF via HttpClient (so the auth interceptor attaches
   * the bearer) and return a `blob:` URL the grid can drop into <img src>.
   * Caches by absPath so re-renders / scroll-back don't re-fetch.
   */
  getThumbBlobUrl(absPath: string): Promise<string> {
    const cached = this.thumbBlobCache.get(absPath);
    if (cached) return cached;

    const promise = firstValueFrom(
      this.http.get(this.thumbUrl(absPath), { responseType: 'blob' }),
    ).then((blob) => URL.createObjectURL(blob));

    this.thumbBlobCache.set(absPath, promise);
    // If the request fails, drop the cached promise so the next attempt can
    // retry instead of getting a permanently rejected promise.
    promise.catch(() => this.thumbBlobCache.delete(absPath));
    return promise;
  }

  /** Drop every cached blob URL (e.g. on sign-out). */
  clearThumbCache(): void {
    for (const p of this.thumbBlobCache.values()) {
      p.then((url) => URL.revokeObjectURL(url)).catch(() => {});
    }
    this.thumbBlobCache.clear();
  }

  /**
   * Stream the RAW bytes via `/api/fs/raw?path=<abs>`. Used by the editor's
   * cold-load path on Self-Hosted, where there's no Mongo asset id to look
   * up in `bun-api-backend.getRawBytes` — the asset's identity is its
   * absolute filesystem path. Goes through HttpClient so the auth
   * interceptor attaches the bearer.
   */
  getRawBytes(absPath: string, onProgress?: (p: DownloadProgress) => void): Promise<ArrayBuffer> {
    const q = new URLSearchParams({ path: absPath });
    const url = `${this.base}/fs/raw?${q.toString()}`;

    // Fast path: no progress consumer → buffer silently, exactly as before.
    if (!onProgress) {
      return firstValueFrom(this.http.get(url, { responseType: 'arraybuffer' }));
    }

    // Progress path: observe download events. We emit `DownloadProgress` to
    // the callback as bytes stream in and resolve with the final body. The
    // emission contract stays "resolve with the ArrayBuffer" — the callback
    // is the only extra surface, so existing callers are unaffected.
    return lastValueFrom(
      this.http
        .get(url, {
          responseType: 'arraybuffer',
          observe: 'events',
          reportProgress: true,
        })
        .pipe(
          map((event) => {
            if (event.type === HttpEventType.DownloadProgress) {
              onProgress({ loaded: event.loaded, total: event.total ?? null });
              return null;
            }
            if (event.type === HttpEventType.Response) {
              // A successful download always carries a body. A null/missing
              // body here means the request broke or aborted mid-stream —
              // fail fast with a clear error instead of handing back a 0-byte
              // buffer that would later surface as a baffling RAW decode error.
              if (event.body == null) {
                throw new Error(
                  `getRawBytes: empty response body for ${absPath} (status ${event.status})`,
                );
              }
              return event.body;
            }
            return null;
          }),
          filter((body): body is ArrayBuffer => body !== null),
        ),
    );
  }
}
