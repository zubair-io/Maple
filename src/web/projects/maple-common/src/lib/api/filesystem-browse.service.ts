// FilesystemBrowseService — the absolute-path thumbnail surface for the
// Self-Hosted grids that are still keyed on server-side `abs_path`s (search
// results, timeline rows, map pins, people covers), plus the one remaining
// pre-registration filesystem call.
//
// After the #1325 web cutover nothing here talks to `/api/fs/dir-fast`,
// `/api/fs/thumb` or `/api/fs/raw` any more. An absolute path is resolved
// through the registered libraries (`LibraryStore.registeredFolders`) to its
// `slug:relPath` address and the thumbnail is fetched from the unified
// `/api/thumb/:slug/*` route via `LibrarySource.thumbBlob` (`HttpLibrarySource`
// on Self-Hosted) — the same route, and so the same server cache entry, the
// browse grid already uses.
//
// `roots()` (`/api/fs/roots`) deliberately stays: it seeds folder pickers
// that walk the filesystem BEFORE a library is registered (Settings →
// Imports source picker, first-run library picker), which by definition have
// no slug to address by. Those pickers list through
// `BunApiBackendService.listDir` (`/api/fs/list`) for the same reason.

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom, map } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import type { MapleAddress } from '../addressing/maple-address';
import { LibraryStore } from '../state/library-store.service';
import { SERVER_LIBRARY_IO, type ApiFolder } from '../workspace/server-library-io';

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

/**
 * Inverse of `LibraryStore.absPathFor`: the `slug:relPath` address of an
 * absolute on-disk path, resolved through the registered libraries. When
 * roots nest, the longest matching root wins (the same rule the store's
 * legacy `fs:` branch uses). Matches on whole path segments only, so
 * `/photos/library2` is never claimed by the `/photos/library` root. Falls
 * back to the folder id as the slug for pre-slug-era registrations, exactly
 * as `absPathFor` does in the other direction. `null` when no registered
 * library owns the path.
 */
export function addressForAbsPath(
  absPath: string,
  folders: readonly ApiFolder[],
): MapleAddress | null {
  const owner = folders
    .map((f) => ({ folder: f, root: f.path.replace(/\/+$/, '') }))
    .filter(({ root }) => absPath === root || absPath.startsWith(`${root}/`))
    .reduce<{ folder: ApiFolder; root: string } | null>(
      (best, candidate) =>
        best === null || candidate.root.length > best.root.length ? candidate : best,
      null,
    );
  if (owner === null) return null;
  const relPath = absPath === owner.root ? '' : absPath.slice(owner.root.length + 1);
  return { slug: owner.folder.slug ?? owner.folder.id, relPath };
}

@Injectable({ providedIn: 'root' })
export class FilesystemBrowseService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  /** `HttpLibrarySource` on Self-Hosted — the only deployment with server-side
   * absolute paths to resolve. Injected by token so Hosted's eager bundle does
   * not pick up the HTTP source it never uses (`check-hosted-capability-boundary`). */
  private readonly librarySource = inject(LIBRARY_SOURCE);
  private readonly store = inject(LibraryStore);
  /** Self-Hosted only; `null` on Hosted, where nothing calls the thumb path. */
  private readonly serverLibrary = inject(SERVER_LIBRARY_IO, { optional: true });

  /**
   * Cache of `absPath → Promise<blob:url>`. Promises live here (not just URLs)
   * so concurrent requests for the same thumbnail share a single network
   * round-trip. The Promise resolves to a `blob:` URL backed by an
   * `image/avif` blob; bind it to an <img> via [src].
   */
  private readonly thumbBlobCache = new Map<string, Promise<string>>();

  /**
   * One shared `/api/folders` load for the case where a thumb is requested
   * before Browse has populated `registeredFolders` (a cold `/search`,
   * `/timeline` or `/map` deep link). Mirrors
   * `XmpAdjustmentRestoreService._ensureRegisteredFolders`.
   */
  private foldersLoad: Promise<void> | null = null;

  /** GET /api/fs/roots — the MAPLE_ROOTS jail roots (default `["/"]`). A
   * pre-registration picker starts browsing here instead of at a library. */
  roots(): Observable<string[]> {
    return this.http.get<{ roots: string[] }>(`${this.base}/fs/roots`).pipe(map((r) => r.roots));
  }

  /**
   * Resolve `absPath` to its `slug:relPath` address, fetch the thumbnail
   * from `/api/thumb/:slug/*` via HttpClient (so the auth interceptor
   * attaches the bearer) and return a `blob:` URL the grid can drop into
   * <img src>. Caches by absPath so re-renders / scroll-back don't re-fetch.
   *
   * Rejects — and forgets the entry so a later call retries — when no
   * registered library owns the path or the server has no thumbnail yet
   * (a `202` while the discover scan indexes the file). Callers keep their
   * placeholder in both cases.
   */
  getThumbBlobUrl(absPath: string): Promise<string> {
    const cached = this.thumbBlobCache.get(absPath);
    if (cached) return cached;

    const promise = this.resolveAddress(absPath).then(async (address) => {
      const blob = await this.librarySource.thumbBlob(address);
      if (!blob) throw new Error(`getThumbBlobUrl: thumbnail not ready for ${absPath}`);
      return URL.createObjectURL(blob);
    });

    this.thumbBlobCache.set(absPath, promise);
    // If the request fails, drop the cached promise so the next attempt can
    // retry instead of getting a permanently rejected promise.
    promise.catch(() => this.thumbBlobCache.delete(absPath));
    return promise;
  }

  /** Drop every cached blob URL (e.g. on sign-out or a folder switch). */
  clearThumbCache(): void {
    for (const p of this.thumbBlobCache.values()) {
      p.then((url) => URL.revokeObjectURL(url)).catch(() => {});
    }
    this.thumbBlobCache.clear();
  }

  private async resolveAddress(absPath: string): Promise<MapleAddress> {
    await this.ensureRegisteredFolders();
    const address = addressForAbsPath(absPath, this.store.registeredFolders());
    if (!address) {
      throw new Error(`getThumbBlobUrl: ${absPath} is not under a registered library`);
    }
    return address;
  }

  private ensureRegisteredFolders(): Promise<void> {
    if (this.store.registeredFolders().length > 0) return Promise.resolve();
    if (!this.serverLibrary) return Promise.resolve();
    const serverLibrary = this.serverLibrary;
    this.foldersLoad ??= firstValueFrom(serverLibrary.listFolders())
      .then((folders) => {
        // Don't stomp a richer list a concurrent loadFolderTree() landed.
        if (this.store.registeredFolders().length === 0) {
          this.store.registeredFolders.set(folders);
        }
      })
      .catch((err: unknown) => {
        this.foldersLoad = null; // allow a later thumb request to retry
        throw err;
      });
    return this.foldersLoad;
  }
}
