import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';
import type { WorkflowHistoryEntry } from '../generated/workflow.generated';

/** Server-only persistence used by shared editor code. Browser filesystem
 * writes remain in XmpStoreService and MapleCacheService. */
export interface ServerWorkspacePersistence {
  readSidecar(path: string): Observable<string | null>;
  writeSidecar(path: string, xml: string): Observable<string>;
  commitSidecar(
    path: string,
    expectedXmp: string | null,
    xmp: string,
    entry: WorkflowHistoryEntry,
  ): Observable<string>;
  writePreview(
    path: string,
    bytes: Blob,
    contentType: 'image/avif' | 'image/jpeg',
  ): Observable<void>;
}

export const SERVER_WORKSPACE_PERSISTENCE = new InjectionToken<ServerWorkspacePersistence | null>(
  'SERVER_WORKSPACE_PERSISTENCE',
);
