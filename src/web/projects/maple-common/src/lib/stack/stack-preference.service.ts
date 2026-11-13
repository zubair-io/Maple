// StackPreferenceService — the user's RAW+JPEG stacking preference (#5050).
//
// The server folds a same-stem RAW+JPEG pair only for a request that carries
// `stack=1` (docs/server-api.md, the `stack` query parameter); the
// `stack_raw_jpeg` display setting is the preference a stack-aware client
// reads to decide whether to send it. Default on, also when an older server
// omits the field or the setting cannot be read.

import { Injectable, inject } from '@angular/core';
import { HttpParams } from '@angular/common/http';
import {
  Observable,
  catchError,
  defer,
  firstValueFrom,
  map,
  of,
  shareReplay,
  switchMap,
  take,
} from 'rxjs';
import { SERVER_LIBRARY_IO } from '../workspace/server-library-io';

@Injectable({ providedIn: 'root' })
export class StackPreferenceService {
  private readonly io = inject(SERVER_LIBRARY_IO, { optional: true });
  private saved: boolean | null = null;
  /** Read from the server once per session; emits synchronously once known. */
  private readonly fromServer$ = defer(() =>
    this.io
      ? this.io.getDisplayConfig().pipe(
          map((config) => config.stack_raw_jpeg ?? true),
          catchError(() => of(true)),
        )
      : of(true),
  ).pipe(shareReplay(1));

  private enabled$(): Observable<boolean> {
    return this.saved === null ? this.fromServer$.pipe(take(1)) : of(this.saved);
  }

  /** The preference. */
  load(): Promise<boolean> {
    return firstValueFrom(this.enabled$());
  }

  /** Record a preference the user just saved. */
  set(enabled: boolean): void {
    this.saved = enabled;
  }

  /** `{ stack: '1' }` when stacking is on, for a listing request's params. */
  async params(): Promise<Record<string, string>> {
    return (await this.load()) ? { stack: '1' } : {};
  }

  /** Issue `request` once the preference is known, with `stack=1` added to
   * `params` when stacking is on (search, facets and map clusters). */
  withStackParam<T>(
    params: HttpParams,
    request: (params: HttpParams) => Observable<T>,
  ): Observable<T> {
    return this.enabled$().pipe(
      switchMap((enabled) => request(enabled ? params.set('stack', '1') : params)),
    );
  }
}
