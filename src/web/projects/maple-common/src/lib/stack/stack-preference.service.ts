// StackPreferenceService — the user's RAW+JPEG stacking preference (#5050).
//
// The server folds a same-stem RAW+JPEG pair only for a request that carries
// `stack=1` (docs/server-api.md, the `stack` query parameter); the
// `stack_raw_jpeg` display setting is the preference a stack-aware client
// reads to decide whether to send it. Default on, also when an older server
// omits the field or the setting cannot be read.

import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SERVER_LIBRARY_IO } from '../workspace/server-library-io';

@Injectable({ providedIn: 'root' })
export class StackPreferenceService {
  private readonly io = inject(SERVER_LIBRARY_IO, { optional: true });
  private loaded: Promise<boolean> | null = null;

  /** The preference, read from the server once per session. */
  load(): Promise<boolean> {
    this.loaded ??= this.io
      ? firstValueFrom(this.io.getDisplayConfig()).then(
          (config) => config.stack_raw_jpeg ?? true,
          () => true,
        )
      : Promise.resolve(true);
    return this.loaded;
  }

  /** Record a preference the user just saved. */
  set(enabled: boolean): void {
    this.loaded = Promise.resolve(enabled);
  }

  /** `{ stack: '1' }` when stacking is on, for a listing/search request's params. */
  async params(): Promise<Record<string, string>> {
    return (await this.load()) ? { stack: '1' } : {};
  }
}
