// Self Hosted lens-profile cache client (#3479): `POST /api/lens-profiles`
// (multipart `file`) and `GET /api/lens-profiles/:digest` — see
// docs/server-api.md. Loaded lazily through `lens-profile-server-bridge.ts`;
// `HttpClient` keeps the app's normal auth interceptor.

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, from, switchMap } from 'rxjs';
import { API_BASE_URL } from '../api/api-base-url.token';
import { cacheLensProfile, lensProfileDigest } from './lens-profile-cache';
import type { LensProfileInventory } from './lens-profile.types';

@Injectable({ providedIn: 'root' })
export class LensProfileServer {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  // Called through the lazy module injector in lens-profile-server-bridge.ts.
  // fallow-ignore-next-line unused-class-member
  upload(file: File): Observable<LensProfileInventory> {
    const body = new FormData();
    body.append('file', file);
    return this.http.post<LensProfileInventory>(`${this.base}/lens-profiles`, body);
  }

  /** Download the exact bytes and persist them where the worker restores from. */
  // fallow-ignore-next-line unused-class-member
  restore(reference: string): Observable<void> {
    const digest = lensProfileDigest(reference);
    return this.http
      .get(`${this.base}/lens-profiles/${digest}`, { responseType: 'arraybuffer' })
      .pipe(
        switchMap((bytes) =>
          from(
            cacheLensProfile(
              reference,
              new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
            ),
          ),
        ),
      );
  }
}
