// FilesystemBrowseService — wraps the auth-gated /api/fs/* endpoints.
//
// Phase B of the "browse by walking the filesystem" feature: the registered
// libraries from /api/folders are still the roots of the sidebar tree, but
// once the user opens one we walk the directory tree directly via
//   GET /api/fs/dir?path=<abs>     → sub-dirs + RAW images at one level
//   GET /api/fs/thumb?path=<abs>   → image/jpeg bytes (cached on disk by API)
// instead of going through Mongo-keyed /api/folders/{id}/assets.
//
// Both endpoints sit behind requireAuth on the server. /api/fs/dir is JSON
// and rides through HttpClient (so the auth interceptor attaches the bearer).
// /api/fs/thumb returns image bytes — we fetch via HttpClient too and turn
// the Blob into an object URL so the bearer-less <img src=...> works.

import { Injectable, inject } from "@angular/core";
import { HttpClient, HttpParams } from "@angular/common/http";
import { Observable, firstValueFrom } from "rxjs";
import { API_BASE_URL } from "./api-base-url.token";

export interface FsDirEntry {
  /** Basename. */
  name: string;
  /** Absolute, symlink-resolved path on disk. */
  path: string;
  /** ISO-8601 mtime from the server. */
  mtime: string;
}

/**
 * EXIF subset returned by `/api/fs/dir` per image. Mirrors the server-side
 * `AssetExif` schema in `src/api/src/db/schema.ts` so the browse listing
 * can populate the Info-tab metadata fields without a second round-trip.
 *
 * `undefined` on an FsImageEntry means the image hasn't been indexed yet;
 * `null` means the indexer ran but found no usable EXIF; populated values
 * mean a partial parse landed.
 */
export interface FsImageExif {
  captured_at: string | null;
  camera_make: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  aperture: number | null;
  shutter: string | null;
  focal_length: number | null;
  gps: { lat: number; lng: number } | null;
}

export interface FsImageEntry extends FsDirEntry {
  size: number;
  /** Lowercase extension, no dot. */
  ext: string;
  /**
   * Mongo asset `_id` (hex). Present when the indexer has registered this
   * file; absent when the file hasn't been indexed yet. Used to call
   * `/api/assets/:id` for the enriched detail payload (place, faces,
   * description, ocr) — FS-walk assets have no other route back to the
   * asset doc since the client-side id is `fs:${abs_path}`.
   */
  id?: string;
  exif?: FsImageExif | null;
}

export interface FsDirListing {
  /** Resolved absolute path of the listed directory. */
  path: string;
  /** Parent directory, or null at MAPLE_ROOTS. */
  parent: string | null;
  dirs: FsDirEntry[];
  images: FsImageEntry[];
}

@Injectable({ providedIn: "root" })
export class FilesystemBrowseService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /**
   * Cache of `path → Promise<blob:url>`. Promises live here (not just URLs)
   * so concurrent requests for the same thumbnail share a single network
   * round-trip. The Promise resolves to a `blob:` URL backed by an
   * `image/jpeg` blob; bind it to an <img> via [src].
   */
  private readonly thumbBlobCache = new Map<string, Promise<string>>();

  /** GET /api/fs/dir?path=<abs>. Returns subdirs + RAW images at one level. */
  listDir(absPath: string): Observable<FsDirListing> {
    const params = new HttpParams().set("path", absPath);
    return this.http.get<FsDirListing>(`${this.base}/fs/dir`, { params });
  }

  /**
   * Plain URL form for cases where the bearer isn't required (e.g. logging,
   * or an open-Web public deployment). NOT what `<img src>` uses today —
   * use {@link getThumbBlobUrl} for that, since /api/fs/thumb is auth-gated
   * and `<img>` requests bypass the HttpClient interceptor.
   */
  thumbUrl(absPath: string, size = 512): string {
    const q = new URLSearchParams({ path: absPath, size: String(size) });
    return `${this.base}/fs/thumb?${q.toString()}`;
  }

  /**
   * Fetch a thumbnail JPEG via HttpClient (so the auth interceptor attaches
   * the bearer) and return a `blob:` URL the grid can drop into <img src>.
   * Caches by absPath so re-renders / scroll-back don't re-fetch.
   */
  getThumbBlobUrl(absPath: string, size = 512): Promise<string> {
    const cached = this.thumbBlobCache.get(absPath);
    if (cached) return cached;

    const promise = firstValueFrom(
      this.http.get(this.thumbUrl(absPath, size), { responseType: "blob" }),
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
  getRawBytes(absPath: string): Promise<ArrayBuffer> {
    const q = new URLSearchParams({ path: absPath });
    return firstValueFrom(
      this.http.get(`${this.base}/fs/raw?${q.toString()}`, {
        responseType: "arraybuffer",
      }),
    );
  }
}
