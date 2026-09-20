import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { API_BASE_URL } from './api-base-url.token';

export interface DbBackupPolicy {
  enabled: boolean;
  bucket: string;
  hour: number;
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
}

export interface DbBackupSettings {
  policy: DbBackupPolicy;
  running?: boolean;
  last_success_at: string | null;
  status: {
    state: 'running' | 'succeeded' | 'failed';
    started_at: string;
    finished_at?: string;
    key?: string;
    bytes?: number;
    compressed_bytes?: number;
    error?: string;
    retention_error?: string;
  } | null;
}

@Injectable({ providedIn: 'root' })
export class DbBackupService {
  private readonly http = inject(HttpClient);
  private readonly url = `${inject(API_BASE_URL)}/admin/backup/db`;
  settings() {
    return this.http.get<DbBackupSettings>(this.url);
  }
  save(policy: DbBackupPolicy) {
    return this.http.put<DbBackupSettings>(`${this.url}/config`, policy);
  }
  start() {
    return this.http.post<{ accepted: boolean }>(this.url, {});
  }
}
