// AiApiService — typed HttpClient wrapper for /api/ai/*.
//
// Operator AI settings: providers credentials, dynamic model listing,
// health testing, and worker mapping.

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

export interface AiProvidersConfig {
  ollama: {
    url?: string | null;
    servers?: Array<{ url: string; concurrency?: number | null }> | null;
  };
  openai: {
    has_key: boolean;
  };
  anthropic: {
    has_key: boolean;
  };
  gemini: {
    has_key: boolean;
  };
}

export interface AiWorkerAssignment {
  provider: string;
  model: string;
}

export interface AvailableWorker {
  id: string;
  name: string;
}

export interface AiConfigResponse {
  providers: AiProvidersConfig;
  workers: Record<string, AiWorkerAssignment>;
  available_workers: AvailableWorker[];
}

export interface UpdateAiConfigPayload {
  providers?: {
    ollama?: {
      url?: string | null;
      servers?: Array<{ url: string; concurrency?: number | null }> | null;
    };
    openai?: { api_key?: string | null };
    anthropic?: { api_key?: string | null };
    gemini?: { api_key?: string | null };
  };
  workers?: Record<string, { provider: string; model: string }>;
}

export interface ModelQueryPayload {
  provider: string;
  url?: string | null;
  api_key?: string | null;
}

export interface ModelsResponse {
  models: string[];
  provider: string;
  error?: string | null;
}

export interface TestConnectionPayload {
  provider: string;
  url?: string | null;
  api_key?: string | null;
}

export interface TestConnectionResponse {
  ok: boolean;
  error?: string | null;
  status?: number;
}

@Injectable({ providedIn: 'root' })
export class AiApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  getConfig(): Observable<AiConfigResponse> {
    return this.http.get<AiConfigResponse>(`${this.baseUrl}/ai/config`);
  }

  updateConfig(payload: UpdateAiConfigPayload): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${this.baseUrl}/ai/config`, payload);
  }

  listModels(payload: ModelQueryPayload): Observable<ModelsResponse> {
    return this.http.post<ModelsResponse>(`${this.baseUrl}/ai/models`, payload);
  }

  testConnection(payload: TestConnectionPayload): Observable<TestConnectionResponse> {
    return this.http.post<TestConnectionResponse>(`${this.baseUrl}/ai/test`, payload);
  }
}
