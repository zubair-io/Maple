import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import { API_BASE_URL } from '../api/api-base-url.token';
import type { ExportJobView, ExportRecipeServer } from './export-recipe-server';
import type { RecipeQueueRecord } from './export-recipe-store';

@Injectable({ providedIn: 'root' })
export class SelfHostedExportRecipeService implements ExportRecipeServer {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  // Called through the EXPORT_RECIPE_SERVER injection-token interface.
  // fallow-ignore-next-line unused-class-member
  create(record: RecipeQueueRecord): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/jobs`, {
      kind: 'batch_recipe_export',
      requestId: record.serverJobId,
      payload: {
        recipe: record.recipe,
        targets: record.targets.map(({ id, path, xmp, index, capturedAt }) => ({
          id,
          path,
          xmp,
          index,
          capturedAt,
        })),
      },
    });
  }
  // Called through the EXPORT_RECIPE_SERVER injection-token interface.
  // fallow-ignore-next-line unused-class-member
  get(id: string): Observable<ExportJobView> {
    return this.http.get<ExportJobView>(`${this.base}/jobs/${id}?summary=1`);
  }
  // Called through the EXPORT_RECIPE_SERVER injection-token interface.
  // fallow-ignore-next-line unused-class-member
  resume(id: string): Observable<unknown> {
    return this.http.post(`${this.base}/jobs/${id}/resume`, {});
  }
  // Called through the EXPORT_RECIPE_SERVER injection-token interface.
  // fallow-ignore-next-line unused-class-member
  cancel(id: string): Observable<unknown> {
    return this.http.post(`${this.base}/jobs/${id}/cancel`, {});
  }
}
