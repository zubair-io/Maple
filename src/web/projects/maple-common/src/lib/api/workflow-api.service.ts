import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';
import {
  PRIMARY_VARIANT_ID,
  type WorkflowHistoryEntry,
  type WorkflowSnapshot,
} from '../generated/workflow.generated';

/** Complete-XMP preconditions authorize one primary semantic publication (#4053). */
@Injectable({ providedIn: 'root' })
export class WorkflowApiService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  restore(path: string, expectedXmp: string, entry: WorkflowHistoryEntry): Observable<string> {
    return this.http.post(
      `${this.base}/xmp/variant/restore?path=${encodeURIComponent(path)}&variantId=${PRIMARY_VARIANT_ID}`,
      { expectedXmp, entry },
      { responseType: 'text' },
    );
  }

  snapshot(
    path: string,
    expectedXmp: string | null,
    snapshot: WorkflowSnapshot,
    initialXmp?: string,
  ): Observable<string> {
    return this.http.post(
      `${this.base}/xmp/variant/snapshot?path=${encodeURIComponent(path)}&variantId=${PRIMARY_VARIANT_ID}`,
      { expectedXmp, snapshot, initialXmp },
      { responseType: 'text' },
    );
  }

  commit(
    path: string,
    expectedXmp: string | null,
    xmp: string,
    entry: WorkflowHistoryEntry,
  ): Observable<string> {
    return this.http.post(
      `${this.base}/xmp/variant/commit?path=${encodeURIComponent(path)}&variantId=${PRIMARY_VARIANT_ID}`,
      { expectedXmp, xmp, entry },
      { responseType: 'text' },
    );
  }
}
