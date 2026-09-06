import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';
import type { RecipeQueueRecord } from './export-recipe-store';
export interface ExportJobView {
  id: string;
  status: 'queued' | 'running' | 'done' | 'cancelled' | 'failed';
  progress: { current: number; total: number };
  error: string | null;
  checkpoint?: ExportJobSummary;
  result: ExportJobSummary | null;
}
export interface ExportJobSummary {
  applied: string[];
  skipped: string[];
  failed: { id: string; reason: string }[];
  remaining: string[];
  outputs: { id: string; path: string }[];
}
export interface ExportRecipeServer {
  create(record: RecipeQueueRecord): Observable<{ id: string }>;
  get(id: string): Observable<ExportJobView>;
  resume(id: string): Observable<unknown>;
  cancel(id: string): Observable<unknown>;
}
export const EXPORT_RECIPE_SERVER = new InjectionToken<ExportRecipeServer>('EXPORT_RECIPE_SERVER');
