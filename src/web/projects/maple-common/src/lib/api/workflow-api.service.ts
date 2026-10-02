import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';
import { PRIMARY_VARIANT_ID, type WorkflowHistoryEntry } from '../generated/workflow.generated';

/** Complete-XMP preconditions authorize one primary semantic publication (#4053). */
@Injectable({ providedIn: 'root' })
export class WorkflowApiService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

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
