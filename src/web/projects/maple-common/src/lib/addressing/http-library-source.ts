// HttpLibrarySource — LibrarySource impl for Self-Hosted.
//
// Routes all calls through the M1 API:
//   GET /api/folder/:slug/*  → FolderListing JSON
//   GET /api/image/:slug/*   → original bytes
//   GET /api/thumb/:slug/*   → thumbnail JPEG (immutable-cached)
//   GET /api/preview/:slug/* → preview JPEG (immutable-cached)
//
// All four methods go through HttpClient so the authInterceptor attaches the
// bearer token. /api/thumb|preview are behind requireAuth (bearer-only — see
// auth/middleware.ts), so a bare `<img src>` with no Authorization header
// would 401. thumbBlob/previewBlob return the JPEG as a Blob; the CALLER owns
// the object-URL lifecycle (create + revoke — see ThumbLruCache).

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../api/api-base-url.token';
import { toApiPath } from './maple-address';
import type { MapleAddress } from './maple-address';
import type { LibrarySource, FolderListing } from './library-source';

@Injectable({ providedIn: 'root' })
export class HttpLibrarySource implements LibrarySource {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  listFolder(a: MapleAddress): Promise<FolderListing> {
    return firstValueFrom(this.http.get<FolderListing>(`${this.base}/folder/${toApiPath(a)}`));
  }

  imageBlob(a: MapleAddress): Promise<Blob> {
    return firstValueFrom(
      this.http.get(`${this.base}/image/${toApiPath(a)}`, { responseType: 'blob' }),
    );
  }

  thumbBlob(a: MapleAddress): Promise<Blob> {
    return firstValueFrom(
      this.http.get(`${this.base}/thumb/${toApiPath(a)}`, { responseType: 'blob' }),
    );
  }

  previewBlob(a: MapleAddress): Promise<Blob> {
    return firstValueFrom(
      this.http.get(`${this.base}/preview/${toApiPath(a)}`, { responseType: 'blob' }),
    );
  }
}
