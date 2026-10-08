import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

export interface MeilisearchEmbedderSummary {
  url: string | null;
  model: string | null;
}

export interface MeilisearchEmbedderDrift {
  state: 'unconfigured' | 'unreachable' | 'pending' | 'in_sync' | 'drift';
  configured: MeilisearchEmbedderSummary | null;
  live: MeilisearchEmbedderSummary | null;
  changedFields: string[];
  documentCount: number | null;
  reembedsAllDocuments: boolean;
}

export interface MeilisearchEmbedderApplyResult {
  taskUid: number | null;
  reembedsAllDocuments: boolean;
  documentCount: number | null;
}

/** The search index's live embedder vs Settings, and the explicit operator
 * action that applies Settings to it (#4432). */
@Injectable({ providedIn: 'root' })
export class MeilisearchEmbedderApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  getDrift(): Observable<MeilisearchEmbedderDrift> {
    return this.http.get<MeilisearchEmbedderDrift>(
      `${this.baseUrl}/admin/enrichment/meilisearch-embedder`,
    );
  }

  apply(): Observable<MeilisearchEmbedderApplyResult> {
    return this.http.post<MeilisearchEmbedderApplyResult>(
      `${this.baseUrl}/admin/enrichment/meilisearch-embedder/apply`,
      {},
    );
  }
}
