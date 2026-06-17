// HttpLibrarySource — LibrarySource impl for Self-Hosted.
//
// Routes all calls through the M1 API:
//   GET /api/folder/:slug/*  → FolderListing JSON
//   GET /api/image/:slug/*   → original bytes
//   GET /api/thumb/:slug/*   → thumbnail JPEG (immutable-cached)
//   GET /api/preview/:slug/* → preview JPEG (immutable-cached)
//
// thumbUrl and previewUrl return plain HTTP URL strings — the browser fetches
// and caches them via Cache-Control: immutable. No blob round-trip needed for
// <img src>. Only listFolder and imageBlob go through HttpClient.

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

  thumbUrl(a: MapleAddress): Promise<string> {
    return Promise.resolve(`${this.base}/thumb/${toApiPath(a)}`);
  }

  previewUrl(a: MapleAddress): Promise<string> {
    return Promise.resolve(`${this.base}/preview/${toApiPath(a)}`);
  }
}
