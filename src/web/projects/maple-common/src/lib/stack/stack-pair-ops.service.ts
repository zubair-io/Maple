import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, defer, forkJoin, map, of, shareReplay, switchMap } from 'rxjs';
import { API_BASE_URL } from '../api/api-base-url.token';
import {
  BunApiBackendService,
  type ApiCollisionPolicy,
  type ApiRelocatedResult,
  type ApiRelocateSkippedResult,
  type ApiRenamedResult,
  type ApiRenameSkippedResult,
} from '../api/bun-api-backend.service';

export interface ApiStackCompanionResult {
  newAbsPath: string;
  newPath: string;
  newFilename: string;
}

export type StackPairRenameOutcome =
  | (ApiRenamedResult & { companion?: ApiStackCompanionResult })
  | (ApiRenameSkippedResult & { collisionFilename?: string });

export type StackPairRelocateOutcome =
  | (ApiRelocatedResult & { companion?: ApiStackCompanionResult })
  | (ApiRelocateSkippedResult & { collisionFilename?: string });

interface PairResponseRaw {
  new_abs_path?: string;
  new_path?: string;
  new_filename?: string;
  renamed_on_collision?: boolean;
  extension_changed?: boolean;
  skipped?: true;
  reason?: string;
  collision_filename?: string;
  companion?: { new_abs_path?: string; new_path?: string; new_filename?: string };
}

function companionOf(raw: PairResponseRaw): ApiStackCompanionResult | undefined {
  return raw.companion
    ? {
        newAbsPath: raw.companion.new_abs_path ?? '',
        newPath: raw.companion.new_path ?? '',
        newFilename: raw.companion.new_filename ?? '',
      }
    : undefined;
}

@Injectable({ providedIn: 'root' })
export class StackPairOpsService {
  private readonly api = inject(BunApiBackendService);
  private readonly http = inject(HttpClient, { optional: true });
  private readonly base = inject(API_BASE_URL);
  private readonly cache = new Map<string, Observable<boolean>>();

  supported(): Observable<boolean> {
    const cached = this.cache.get(this.base);
    if (cached) return cached;
    const getDisplayConfig = this.api.getDisplayConfig;
    const result =
      typeof getDisplayConfig === 'function'
        ? defer(() => getDisplayConfig.call(this.api)).pipe(
            map((config) => config.stack_pair_ops_supported === true),
            catchError(() => of(false)),
            shareReplay({ bufferSize: 1, refCount: false }),
          )
        : of(false);
    this.cache.set(this.base, result);
    return result;
  }

  resolveAssetId(idOrAddress: string): Observable<string> {
    return idOrAddress.includes(':')
      ? this.api.getAssetDetailsByAddress(idOrAddress).pipe(map(({ id }) => id))
      : of(idOrAddress);
  }

  renamePair(
    assetIdOrAddress: string,
    companionIdOrAddress: string,
    newFilename: string,
    collision: ApiCollisionPolicy,
    companionCollision: 'skip' | 'replace' = 'skip',
  ): Observable<StackPairRenameOutcome> {
    return this.postPair(assetIdOrAddress, companionIdOrAddress, 'rename', {
      new_filename: newFilename,
      collision,
      companion_collision: companionCollision,
    }).pipe(
      map(
        (r): StackPairRenameOutcome =>
          r.skipped
            ? {
                kind: 'skipped',
                reason: r.reason ?? 'skipped',
                ...(r.collision_filename ? { collisionFilename: r.collision_filename } : {}),
              }
            : {
                kind: 'renamed',
                newAbsPath: r.new_abs_path ?? '',
                newPath: r.new_path ?? '',
                newFilename: r.new_filename ?? newFilename,
                renamedOnCollision: r.renamed_on_collision ?? false,
                extensionChanged: r.extension_changed ?? false,
                ...(companionOf(r) ? { companion: companionOf(r) } : {}),
              },
      ),
    );
  }

  relocatePair(
    assetIdOrAddress: string,
    companionIdOrAddress: string,
    mode: 'move' | 'copy',
    collision: ApiCollisionPolicy,
    companionCollision: 'skip' | 'replace',
    destinationPath: string,
    destinationFilename?: string,
  ): Observable<StackPairRelocateOutcome> {
    return this.postPair(assetIdOrAddress, companionIdOrAddress, 'relocate', {
      mode,
      collision,
      companion_collision: companionCollision,
      destination_path: destinationPath,
      ...(destinationFilename !== undefined ? { destination_filename: destinationFilename } : {}),
    }).pipe(
      map(
        (r): StackPairRelocateOutcome =>
          r.skipped
            ? {
                kind: 'skipped',
                reason: r.reason ?? 'skipped',
                ...(r.collision_filename ? { collisionFilename: r.collision_filename } : {}),
              }
            : {
                kind: 'relocated',
                newAbsPath: r.new_abs_path ?? '',
                newPath: r.new_path ?? '',
                newFilename: r.new_filename ?? destinationFilename ?? '',
                renamedOnCollision: r.renamed_on_collision ?? false,
                ...(companionOf(r) ? { companion: companionOf(r) } : {}),
              },
      ),
    );
  }

  private postPair(
    assetIdOrAddress: string,
    companionIdOrAddress: string,
    action: 'rename' | 'relocate',
    body: Record<string, unknown>,
  ): Observable<PairResponseRaw> {
    if (!this.http)
      return defer(() => {
        throw new Error('Stack pair operations are unavailable');
      });
    const http = this.http;
    return forkJoin({
      id: this.resolveAssetId(assetIdOrAddress),
      companionId: this.resolveAssetId(companionIdOrAddress),
    }).pipe(
      switchMap(({ id, companionId }) =>
        http.post<PairResponseRaw>(`${this.base}/assets/${encodeURIComponent(id)}/${action}`, {
          ...body,
          companion_id: companionId,
          ...(assetIdOrAddress.includes(':') ? { source_address: assetIdOrAddress } : {}),
        }),
      ),
    );
  }
}
