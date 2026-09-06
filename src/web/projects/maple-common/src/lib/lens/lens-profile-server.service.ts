import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, from, switchMap } from 'rxjs';
import { API_BASE_URL } from '../api/api-base-url.token';
import { cacheLensProfile, lensProfileDigest } from './lens-profile-cache';

/** Loaded only for Self Hosted; HttpClient retains the normal auth interceptor. */
@Injectable({ providedIn: 'root' })
export class LensProfileServer {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  // Called through the lazy module injector in lens-profile-server-bridge.ts.
  // fallow-ignore-next-line unused-class-member
  upload(file: File): Observable<{ reference: string }> {
    const body = new FormData();
    body.append('file', file);
    return this.http.post<{ reference: string }>(`${this.base}/lens-profiles`, body);
  }

  // Called through the lazy module injector in lens-profile-server-bridge.ts.
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
