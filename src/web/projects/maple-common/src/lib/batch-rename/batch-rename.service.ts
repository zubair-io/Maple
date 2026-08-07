// BatchRenameService — HTTP orchestration for the Batch Rename dialog
// (#2640). Talks to `POST /api/assets/batch-rename/preview` (dry-run) and
// `POST /api/assets/batch-rename` (apply, sequential — see
// `src/api/src/library/batch-rename.ts`'s module doc for why sequential
// application matters for self-colliding templates).
//
// The endpoints want Mongo ids; the grid only carries `slug:relPath`
// addresses (see `AssetRenameService`'s doc on the same gap for single
// rename). `resolveIds` bridges that the same way `renameAsset` does for
// one asset at a time — `BunApiBackendService.getAssetDetailsByAddress` per
// address, run in parallel via `forkJoin` since there's no bulk
// address-resolution endpoint. An address that fails to resolve (network
// blip, or the asset was deleted between selection and dialog-open) is kept
// in the result set with `id: null` rather than silently dropped — preview
// and apply both turn that into a per-row error so the dialog's "every
// selected file gets a result" guarantee holds even for that edge case.
//
// Not injected directly by shared components — like `AssetRenameService`,
// this is wired up only from Self Hosted's composition root, behind the
// `BATCH_RENAME_ENABLED` token (`batch-rename-capability.ts`).

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, forkJoin, map, of, catchError } from 'rxjs';
import { API_BASE_URL } from '../api/api-base-url.token';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import type {
  BatchRenameApplyResult,
  BatchRenameCollisionPolicy,
  BatchRenameItemResult,
  BatchRenamePreviewItem,
  BatchRenameSelection,
  BatchRenameSummary,
  BatchRenameTemplateOptions,
  ResolvedBatchRenameId,
} from './batch-rename.types';

interface RawPreviewItem {
  id: string;
  old_filename: string | null;
  new_filename: string | null;
  error: string | null;
  duplicate: boolean;
}

interface RawPreviewResponse {
  items: RawPreviewItem[];
}

interface RawApplyResult {
  id: string;
  kind: 'relocated' | 'skipped' | 'not-found' | 'invalid' | 'error';
  old_filename?: string;
  new_filename?: string;
  renamed_on_collision?: boolean;
  extension_changed?: boolean;
  reason?: string;
  error?: string;
}

interface RawApplyResponse {
  summary: BatchRenameSummary;
  results: RawApplyResult[];
}

function unresolvedPreviewItem(row: ResolvedBatchRenameId): BatchRenamePreviewItem {
  return {
    address: row.address,
    oldFilename: row.filename,
    newFilename: null,
    error: 'Could not resolve this asset',
    duplicate: false,
  };
}

function unresolvedApplyResult(row: ResolvedBatchRenameId): BatchRenameItemResult {
  return { address: row.address, kind: 'error', error: 'Could not resolve this asset' };
}

function mapApplyResult(address: string, raw: RawApplyResult): BatchRenameItemResult {
  switch (raw.kind) {
    case 'relocated':
      return {
        address,
        kind: 'relocated',
        oldFilename: raw.old_filename ?? '',
        newFilename: raw.new_filename ?? '',
        renamedOnCollision: raw.renamed_on_collision ?? false,
        extensionChanged: raw.extension_changed ?? false,
      };
    case 'skipped':
      return { address, kind: 'skipped', reason: raw.reason ?? 'skipped' };
    case 'not-found':
      return { address, kind: 'not-found' };
    case 'invalid':
      return { address, kind: 'invalid', error: raw.error ?? 'invalid template result' };
    case 'error':
      return { address, kind: 'error', error: raw.error ?? 'unknown error' };
  }
}

@Injectable({ providedIn: 'root' })
export class BatchRenameService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly api = inject(BunApiBackendService);

  /** Resolve every `address` to its Mongo id, in the caller's order. Never
   * errors as a whole — a single address's resolution failure becomes
   * `id: null` on its row instead of failing the other rows. */
  resolveIds(selections: BatchRenameSelection[]): Observable<ResolvedBatchRenameId[]> {
    if (selections.length === 0) return of([]);
    return forkJoin(
      selections.map((selection) =>
        this.api.getAssetDetailsByAddress(selection.address).pipe(
          map((detail) => ({
            address: selection.address,
            filename: selection.filename,
            id: detail.id,
          })),
          catchError(() =>
            of({ address: selection.address, filename: selection.filename, id: null }),
          ),
        ),
      ),
    );
  }

  /** Dry-run: render every resolved id's new filename without writing
   * anything. Order-preserving against `resolved` (unresolved rows are
   * synthesized locally, no network round-trip for them). */
  preview(
    resolved: ResolvedBatchRenameId[],
    options: BatchRenameTemplateOptions,
  ): Observable<BatchRenamePreviewItem[]> {
    const withIds = resolved.filter(
      (row): row is ResolvedBatchRenameId & { id: string } => row.id !== null,
    );
    if (withIds.length === 0) {
      return of(resolved.map(unresolvedPreviewItem));
    }
    return this.http
      .post<RawPreviewResponse>(`${this.base}/assets/batch-rename/preview`, {
        ids: withIds.map((row) => row.id),
        template: options.template,
        sequence_start: options.sequenceStart,
        sequence_pad_width: options.sequencePadWidth,
      })
      .pipe(
        map((res) => {
          const byAddress = new Map(withIds.map((row, i) => [row.address, res.items[i]!]));
          return resolved.map((row) => {
            if (row.id === null) return unresolvedPreviewItem(row);
            const item = byAddress.get(row.address)!;
            return {
              address: row.address,
              oldFilename: item.old_filename,
              newFilename: item.new_filename,
              error: item.error,
              duplicate: item.duplicate,
            };
          });
        }),
      );
  }

  /** Apply the template, sequentially, via the server's batch-rename route.
   * Unresolved rows never reach the server — they're folded into the
   * summary/result list as `kind: 'error'` so "every selected file gets a
   * result" holds even when resolution failed for some of them. */
  apply(
    resolved: ResolvedBatchRenameId[],
    options: BatchRenameTemplateOptions,
    collision: BatchRenameCollisionPolicy,
  ): Observable<BatchRenameApplyResult> {
    const withIds = resolved.filter(
      (row): row is ResolvedBatchRenameId & { id: string } => row.id !== null,
    );
    const unresolvedResults = resolved.filter((row) => row.id === null).map(unresolvedApplyResult);

    if (withIds.length === 0) {
      return of({
        summary: {
          total: unresolvedResults.length,
          relocated: 0,
          skipped: 0,
          failed: unresolvedResults.length,
        },
        results: unresolvedResults,
      });
    }

    return this.http
      .post<RawApplyResponse>(`${this.base}/assets/batch-rename`, {
        ids: withIds.map((row) => row.id),
        template: options.template,
        sequence_start: options.sequenceStart,
        sequence_pad_width: options.sequencePadWidth,
        collision,
      })
      .pipe(
        map((res) => {
          const resolvedResults = withIds.map((row, i) =>
            mapApplyResult(row.address, res.results[i]!),
          );
          const results = [...resolvedResults, ...unresolvedResults];
          const summary: BatchRenameSummary = {
            total: res.summary.total + unresolvedResults.length,
            relocated: res.summary.relocated,
            skipped: res.summary.skipped,
            failed: res.summary.failed + unresolvedResults.length,
          };
          return { summary, results };
        }),
      );
  }
}
