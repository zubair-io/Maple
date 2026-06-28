// batch-metadata.service.ts — HTTP service for the Batch Metadata panel (#1606).
// Observables only at the service layer (debounce lives in the component).
// computeMixedValues delegates to the pure function in batch-metadata.types.ts
// so it can be unit-tested without Angular DI.
// Spec: docs/superpowers/specs/2026-06-26-batch-metadata-editor-design.md

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import {
  computeMixedValues,
  type AssetMetadataSnapshot,
  type BatchApplyEntry,
  type BatchApplyResult,
  type GeocodeCandidate,
  type MixedValueMap,
  type RefileCountResult,
  type RefileResult,
} from './batch-metadata.types';

@Injectable({ providedIn: 'root' })
export class BatchMetadataService {
  private readonly http = inject(HttpClient);

  // ---------------------------------------------------------------------------
  // Mixed-value computation (delegates to pure function for testability)
  // ---------------------------------------------------------------------------

  computeMixedValues(snapshots: AssetMetadataSnapshot[]): MixedValueMap {
    return computeMixedValues(snapshots);
  }

  // ---------------------------------------------------------------------------
  // Batch apply
  // ---------------------------------------------------------------------------

  /**
   * POST /api/xmp/batch — write metadata fields to N asset sidecars.
   * Partial failures are reported per-asset; successes are not rolled back.
   */
  batchApply(entries: BatchApplyEntry[]): Observable<BatchApplyResult> {
    return this.http.post<BatchApplyResult>('/api/xmp/batch', { entries });
  }

  // ---------------------------------------------------------------------------
  // Geocode search
  // ---------------------------------------------------------------------------

  /**
   * GET /api/geocode/search?q= — forward geocode address search.
   * Returns up to 5 candidates. Debouncing is the caller's responsibility.
   */
  geocodeSearch(q: string): Observable<GeocodeCandidate[]> {
    return this.http
      .get<{ suggestions: GeocodeCandidate[] }>('/api/geocode/search', {
        params: { q },
      })
      .pipe(map((r) => r.suggestions));
  }

  // ---------------------------------------------------------------------------
  // Snapshots (full effective metadata for mixed-value computation)
  // ---------------------------------------------------------------------------

  /**
   * POST /api/metadata/snapshots — fetch full effective metadata for a list of
   * asset paths so the panel can compute "(mixed)" across all 22 fields.
   */
  fetchSnapshots(paths: string[]): Observable<AssetMetadataSnapshot[]> {
    type AssetSnapshotMetadata = AssetMetadataSnapshot['metadata'];
    return this.http
      .post<{
        snapshots: Array<{ path: string; metadata: AssetSnapshotMetadata }>;
      }>('/api/metadata/snapshots', { paths })
      .pipe(map((r) => r.snapshots.map((s) => ({ path: s.path, metadata: s.metadata }))));
  }

  // ---------------------------------------------------------------------------
  // Refile (backup geo-organisation after a GPS apply)
  // ---------------------------------------------------------------------------

  /**
   * POST /api/backup/refile-count — count how many of the given asset paths
   * have a geo-backup copy that would be relocated by the new coordinates.
   * Returns `{ count: number }`.
   */
  refileCount(paths: string[]): Observable<RefileCountResult> {
    return this.http.post<RefileCountResult>('/api/backup/refile-count', { paths });
  }

  /**
   * POST /api/backup/refile — relocate geo-backup copies for the given paths.
   * Partial failures are reported per-asset; successes are not rolled back.
   * Returns `{ results: [...] }`.
   */
  refile(paths: string[]): Observable<RefileResult> {
    return this.http.post<RefileResult>('/api/backup/refile', { paths });
  }
}
