// HttpLibrarySource — LibrarySource impl for Self-Hosted.
//
// Routes all calls through the M1 API:
//   GET /api/folder/:slug/*  → FolderListing JSON
//   GET /api/image/:slug/*   → original bytes
//   GET /api/thumb/:slug/*   → thumbnail AVIF (immutable-cached)
//   GET /api/preview/:slug/* → preview JPEG (immutable-cached)
//
// All four methods go through HttpClient so the authInterceptor attaches the
// bearer token. /api/thumb|preview are behind requireAuth (bearer-only — see
// auth/middleware.ts), so a bare `<img src>` with no Authorization header
// would 401. thumbBlob returns AVIF and previewBlob returns JPEG, both as a
// Blob; the CALLER owns the object-URL lifecycle (create + revoke — see
// ThumbLruCache).

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { firstValueFrom, filter, map } from 'rxjs';
import { API_BASE_URL } from '../api/api-base-url.token';
import type { DownloadProgress } from '../api/filesystem-browse.service';
import { toApiPath, formatAddress } from './maple-address';
import type { MapleAddress } from './maple-address';
import type { LibrarySource, FolderListing } from './library-source';

@Injectable({ providedIn: 'root' })
export class HttpLibrarySource implements LibrarySource {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  listFolder(a: MapleAddress): Promise<FolderListing> {
    return firstValueFrom(this.http.get<FolderListing>(`${this.base}/folder/${toApiPath(a)}`));
  }

  imageBlob(a: MapleAddress, onProgress?: (p: DownloadProgress) => void): Promise<Blob> {
    const url = `${this.base}/image/${toApiPath(a)}`;

    if (!onProgress) {
      return firstValueFrom(this.http.get(url, { responseType: 'blob' }));
    }

    // Stream the body so the editor's open-progress overlay can update. Mirrors
    // BunApiBackendService.getRawBytes: fire onProgress as a side effect, then
    // pass through only the final Response body so firstValueFrom yields one Blob.
    return firstValueFrom(
      this.http.get(url, { responseType: 'blob', observe: 'events', reportProgress: true }).pipe(
        map((event) => {
          if (event.type === HttpEventType.DownloadProgress) {
            onProgress({ loaded: event.loaded, total: event.total ?? null });
            return null;
          }
          if (event.type === HttpEventType.Response) {
            // A successful download always carries a body; a null body means the
            // request aborted mid-stream — fail fast rather than hand back an
            // empty Blob that surfaces later as a baffling RAW decode error.
            if (event.body == null) {
              throw new Error(
                `imageBlob: empty response body for ${formatAddress(a)} (status ${event.status})`,
              );
            }
            return event.body;
          }
          return null;
        }),
        filter((body): body is Blob => body !== null),
      ),
    );
  }

  async thumbBlob(a: MapleAddress): Promise<Blob | null> {
    const res = await firstValueFrom(
      this.http.get(`${this.base}/thumb/${toApiPath(a)}`, {
        responseType: 'blob',
        observe: 'response',
      }),
    );
    // Only a 200 carries a real thumbnail. A 202 (indexing — older servers)
    // or 204 has a JSON/empty body; return null so the caller keeps the
    // gradient placeholder instead of rendering that body as a broken <img>.
    return res.status === 200 ? res.body : null;
  }

  async previewBlob(a: MapleAddress): Promise<Blob | null> {
    const res = await firstValueFrom(
      this.http.get(`${this.base}/preview/${toApiPath(a)}`, {
        responseType: 'blob',
        observe: 'response',
      }),
    );
    return res.status === 200 ? res.body : null;
  }
}
