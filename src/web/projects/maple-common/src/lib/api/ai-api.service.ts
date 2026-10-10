import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

export interface AiConnection {
  id: string;
  name: string;
  provider: string;
  url: string;
  concurrency: number;
  has_key?: boolean;
  api_key?: string | null;
}
export interface AiEmbedderSettings {
  url: string;
  model: string;
  default_url: string;
  default_model: string;
}
export interface AiConnectionsResponse {
  needs_save?: boolean;
  embedder: AiEmbedderSettings;
  connections: AiConnection[];
  assignments: Record<
    string,
    { connection_ids: string[]; model: string; connection_models?: Record<string, string> }
  >;
  available_workers: Array<{
    id: string;
    name: string;
    detail: string;
    multiple: boolean;
    providers: string[];
  }>;
}

export type SearchEngineName = 'meilisearch' | 'in-process';
export interface SearchEngineView {
  engine: SearchEngineName;
  status: {
    phase:
      | 'stopped'
      | 'starting'
      | 'loading'
      | 'ready'
      | 'empty'
      | 'incompatible-embedder'
      | 'failed';
    vectors: number;
    texts: number;
    textReady: boolean;
    restarts: number;
    model?: string;
    matchedModels?: string[];
    skippedVectors?: number;
    error?: string;
  };
  modelCacheDir: string;
}

@Injectable({ providedIn: 'root' })
export class AiApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  getConnections(): Observable<AiConnectionsResponse> {
    return this.http.get<AiConnectionsResponse>(`${this.baseUrl}/ai/connections/`);
  }
  saveConnections(
    config: Pick<AiConnectionsResponse, 'connections' | 'assignments'> & {
      embedder: Pick<AiEmbedderSettings, 'url' | 'model'>;
    },
  ): Observable<AiConnectionsResponse> {
    return this.http.put<AiConnectionsResponse>(`${this.baseUrl}/ai/connections/`, config);
  }
  getSearchEngine(): Observable<SearchEngineView> {
    return this.http.get<SearchEngineView>(`${this.baseUrl}/ai/search-engine/`);
  }
  setSearchEngine(engine: SearchEngineName): Observable<SearchEngineView> {
    return this.http.put<SearchEngineView>(`${this.baseUrl}/ai/search-engine/`, { engine });
  }
  probeConnection(
    connection: AiConnection,
    models: boolean,
  ): Observable<{ ok?: boolean; models?: string[]; error?: string }> {
    return this.http.post<{ ok?: boolean; models?: string[]; error?: string }>(
      `${this.baseUrl}/ai/connections/probe`,
      { connection, models },
    );
  }
}
