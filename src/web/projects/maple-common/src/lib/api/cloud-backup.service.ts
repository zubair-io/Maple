import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';
import type {
  BackupCatalog,
  BackupDestination,
  BackupRestoreJob,
  BackupRestorePreview,
  BackupRestoreRequest,
  GoogleBackupConfig,
  GoogleBackupConfigPatch,
} from './cloud-backup.model';

/** Owner-only backup resources. Credentials are submitted once, never cached here. */
@Injectable({ providedIn: 'root' })
export class CloudBackupService {
  private readonly http = inject(HttpClient);
  private readonly api = inject(API_BASE_URL);
  private readonly base = `${this.api}/cloud-backup`;

  destinations() {
    return this.http
      .get<{ destinations: BackupDestination[] }>(`${this.base}/destinations`)
      .pipe(map((response) => response.destinations));
  }

  createDestination(request: {
    libraryId: string;
    kind: BackupDestination['kind'];
    name: string;
    path?: string;
  }) {
    return this.http
      .post<{ destination: BackupDestination }>(`${this.base}/destinations`, request)
      .pipe(map((response) => response.destination));
  }

  updateDestination(
    id: string,
    request: {
      enabled?: boolean;
      name?: string;
      path?: string;
    },
  ) {
    return this.http
      .patch<{ destination: BackupDestination }>(this.destinationUrl(id), request)
      .pipe(map((response) => response.destination));
  }

  removeDestination(id: string) {
    return this.http.delete<{ ok: boolean }>(this.destinationUrl(id));
  }

  retryDestination(id: string) {
    return this.http.post<{ ok: boolean }>(`${this.destinationUrl(id)}/retry`, {});
  }

  googleConfig(id: string) {
    return this.http.get<GoogleBackupConfig>(`${this.googleUrl(id)}/config`);
  }

  saveGoogleConfig(id: string, patch: GoogleBackupConfigPatch) {
    return this.http.put<GoogleBackupConfig>(`${this.googleUrl(id)}/config`, patch);
  }

  connectGoogle(id: string, rootId?: string) {
    return this.http.post<{ authorizationUrl: string }>(
      `${this.googleUrl(id)}/start`,
      rootId ? { rootId } : {},
    );
  }

  disconnectGoogle(id: string) {
    return this.http.post<GoogleBackupConfig>(`${this.googleUrl(id)}/disconnect`, {});
  }

  createGoogleRoot(id: string) {
    return this.http.post<GoogleBackupConfig>(`${this.googleUrl(id)}/root`, {});
  }

  catalog(id: string) {
    return this.http.get<BackupCatalog>(`${this.destinationUrl(id)}/catalog`);
  }

  previewRestore(id: string, request: BackupRestoreRequest) {
    return this.http.post<BackupRestorePreview>(
      `${this.destinationUrl(id)}/restore/preview`,
      request,
    );
  }

  restore(id: string, request: BackupRestoreRequest) {
    return this.http.post<{ jobId: string }>(`${this.destinationUrl(id)}/restore`, request);
  }

  restoreJob(id: string) {
    return this.http.get<BackupRestoreJob>(`${this.api}/jobs/${encodeURIComponent(id)}`);
  }

  restoreJobs(destinationId: string) {
    return this.http
      .get<{ jobs: BackupRestoreJob[] }>(`${this.destinationUrl(destinationId)}/restore/jobs`)
      .pipe(map((response) => response.jobs));
  }

  cancelRestore(id: string) {
    return this.http.post<{ ok: boolean }>(`${this.api}/jobs/${encodeURIComponent(id)}/cancel`, {});
  }

  resumeRestore(destinationId: string, jobId: string) {
    return this.http.post<{ ok: boolean }>(
      `${this.destinationUrl(destinationId)}/restore/jobs/${encodeURIComponent(jobId)}/resume`,
      {},
    );
  }

  private destinationUrl(id: string) {
    return `${this.base}/destinations/${encodeURIComponent(id)}`;
  }

  private googleUrl(id: string) {
    return `${this.base}/google/${encodeURIComponent(id)}`;
  }
}
