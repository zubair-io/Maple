// Library source provider — factory wiring LIBRARY_SOURCE to the right impl.
//
// Add `provideLibrarySource` to app-level providers in both apps.

import { FactoryProvider, inject } from '@angular/core';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { LIBRARY_SOURCE, type LibrarySource } from './library-source';
import { HttpLibrarySource } from './http-library-source';
import { FsAccessLibrarySource } from './fs-access-library-source';

export { selectLibrarySourceKey } from './library-source-selector';

/**
 * Provider for LIBRARY_SOURCE. Add to app-level providers in both
 * `maple/app.config.ts` and `maple-syrup/app.config.ts`.
 *
 * Self-Hosted → HttpLibrarySource (calls /api/folder|image|thumb|preview).
 * Hosted      → FsAccessLibrarySource (walks FileSystemDirectoryHandles).
 */
export const provideLibrarySource: FactoryProvider = {
  provide: LIBRARY_SOURCE,
  useFactory: (): LibrarySource => {
    const backend = inject(LIBRARY_BACKEND);
    if (backend === 'self-hosted') {
      return inject(HttpLibrarySource);
    }
    return inject(FsAccessLibrarySource);
  },
};
