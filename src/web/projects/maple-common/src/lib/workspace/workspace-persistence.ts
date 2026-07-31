import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';

/** Server-only persistence used by shared editor code. Browser filesystem
 * writes remain in XmpStoreService and MapleCacheService. */
export interface ServerWorkspacePersistence {
  readSidecar(path: string): Observable<string | null>;
  writeSidecar(path: string, xml: string): Observable<void>;
  writePreview(
    path: string,
    bytes: Blob,
    contentType: 'image/avif' | 'image/jpeg',
  ): Observable<void>;
}

export const SERVER_WORKSPACE_PERSISTENCE = new InjectionToken<ServerWorkspacePersistence | null>(
  'SERVER_WORKSPACE_PERSISTENCE',
);
