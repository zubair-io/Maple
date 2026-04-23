// LIBRARY_BACKEND — selects which backend LibraryStateService / FolderAccessService
// talks to. Provided once at the application root:
//   - Hosted      -> 'hosted'       (File System Access API + IndexedDB)
//   - Self Hosted -> 'self-hosted'  (Bun API over HTTP)
//
// Consumers `inject(LIBRARY_BACKEND)` and branch their data source accordingly.

import { InjectionToken } from '@angular/core';

export type LibraryBackendKind = 'hosted' | 'self-hosted';

export const LIBRARY_BACKEND = new InjectionToken<LibraryBackendKind>('LIBRARY_BACKEND', {
  providedIn: 'root',
  factory: () => 'hosted',
});
