import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export interface ManagedHttpsSettings {
  enabled: boolean;
  hostname: string;
  port: number;
  email: string;
  zone_id: string;
  api_token_set: boolean;
  http3: boolean;
  terms_agreed: boolean;
}
export interface ManagedHttpsResponse {
  config: ManagedHttpsSettings;
  status: {
    state: 'disabled' | 'pending' | 'issuing' | 'ready' | 'error';
    expires_at: number | null;
    retry_at: number | null;
    error: string | null;
    http3: boolean;
  };
}
export type ManagedHttpsPatch = Omit<ManagedHttpsSettings, 'api_token_set'> & {
  api_token?: string | null;
};

@Injectable({ providedIn: 'root' })
export class ManagedHttpsService {
  private readonly http = inject(HttpClient);
  load() {
    return this.http.get<ManagedHttpsResponse>('/api/network/https/');
  }
  save(patch: ManagedHttpsPatch) {
    return this.http.put<ManagedHttpsResponse>('/api/network/https/', patch);
  }
}
