// Self Hosted durable transport (#3984). AI runs in the browser's local worker.
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { catchError, map, throwError, type Observable } from 'rxjs';
import { API_BASE_URL } from '../api/api-base-url.token';

export interface RemovalSidecarSnapshot {
  revision: string;
  xml: string;
}

@Injectable({ providedIn: 'root' })
export class RemovalServerIoService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  snapshot(path: string): Observable<RemovalSidecarSnapshot> {
    return this.http
      .get<RemovalSidecarSnapshot>(`${this.base}/removal/xmp`, {
        params: { path },
      })
      .pipe(catchError(serverError));
  }

  commit(
    path: string,
    expectedRevision: string,
    expectedRecords: string,
    xml: string,
  ): Observable<RemovalSidecarSnapshot> {
    return this.http
      .post<RemovalSidecarSnapshot>(
        `${this.base}/removal/xmp`,
        {
          expectedRevision,
          expectedRecords,
          xml,
        },
        { params: { path } },
      )
      .pipe(catchError(serverError));
  }

  read(path: string, name: string): Observable<Uint8Array> {
    return this.http
      .get(`${this.base}/removal/companion`, {
        params: { path, name },
        responseType: 'arraybuffer',
      })
      .pipe(
        map((bytes) => new Uint8Array(bytes)),
        catchError(serverError),
      );
  }

  publish(path: string, name: string, bytes: Uint8Array): Observable<void> {
    return this.http
      .put(`${this.base}/removal/companion`, new Uint8Array(bytes).buffer, {
        params: { path, name },
        headers: { 'Content-Type': 'application/octet-stream' },
      })
      .pipe(
        map(() => undefined),
        catchError(serverError),
      );
  }
}

function serverError(error: unknown): Observable<never> {
  const body: unknown = error instanceof HttpErrorResponse ? error.error : undefined;
  const message =
    error instanceof HttpErrorResponse && error.status === 0
      ? 'Cannot reach the Maple server. Check your connection and retry.'
      : body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : error instanceof HttpErrorResponse || error instanceof Error
          ? error.message
          : String(error);
  return throwError(() => new Error(message));
}
