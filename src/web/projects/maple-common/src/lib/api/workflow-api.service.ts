import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';
import {
  PRIMARY_VARIANT_ID,
  type SidecarWorkflow,
  type WorkflowHistoryEntry,
  type WorkflowSnapshot,
} from '../generated/workflow.generated';
import type { WorkflowVariantSidecar } from '../xmp/workflow-variant-store.service';

/** Complete-XMP publication bound to an explicit branch identity (#4063). */
@Injectable({ providedIn: 'root' })
export class WorkflowApiService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  list(path: string): Observable<WorkflowVariantSidecar[]> {
    return this.http.get<WorkflowVariantSidecar[]>(
      `${this.base}/xmp/variants?path=${encodeURIComponent(path)}`,
    );
  }

  create(
    path: string,
    workflow: SidecarWorkflow,
    sourceVariantId = PRIMARY_VARIANT_ID,
  ): Observable<WorkflowVariantSidecar> {
    return this.http.post<WorkflowVariantSidecar>(
      `${this.base}/xmp/variants?path=${encodeURIComponent(path)}&sourceVariantId=${encodeURIComponent(sourceVariantId)}`,
      workflow,
    );
  }

  read(path: string, variantId: string): Observable<string> {
    return this.http.get(this.variantUrl(path, variantId), { responseType: 'text' });
  }

  write(path: string, xml: string, variantId: string): Observable<string> {
    return this.http.put(this.variantUrl(path, variantId), xml, {
      headers: { 'Content-Type': 'application/xml' },
      responseType: 'text',
    });
  }

  restore(
    path: string,
    expectedXmp: string,
    entry: WorkflowHistoryEntry,
    variantId = PRIMARY_VARIANT_ID,
  ): Observable<string> {
    return this.http.post(
      this.variantUrl(path, variantId, '/restore'),
      { expectedXmp, entry },
      { responseType: 'text' },
    );
  }

  snapshot(
    path: string,
    expectedXmp: string | null,
    snapshot: WorkflowSnapshot,
    initialXmp?: string,
    variantId = PRIMARY_VARIANT_ID,
  ): Observable<string> {
    return this.http.post(
      this.variantUrl(path, variantId, '/snapshot'),
      { expectedXmp, snapshot, initialXmp },
      { responseType: 'text' },
    );
  }

  commit(
    path: string,
    expectedXmp: string | null,
    xmp: string,
    entry: WorkflowHistoryEntry,
    variantId = PRIMARY_VARIANT_ID,
  ): Observable<string> {
    return this.http.post(
      this.variantUrl(path, variantId, '/commit'),
      { expectedXmp, xmp, entry },
      { responseType: 'text' },
    );
  }

  private variantUrl(path: string, variantId: string, operation = ''): string {
    return `${this.base}/xmp/variant${operation}?path=${encodeURIComponent(path)}&variantId=${encodeURIComponent(variantId)}`;
  }
}
