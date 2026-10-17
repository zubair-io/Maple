// Sidecar write bookkeeping shared with XmpStoreService; extracted to keep
// the store under the file-size budget.
import type { AdjustmentModel } from '../models/adjustment-model';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import type { PassthroughBucket, XmpCulling, XmpMetadata } from './xmp.types';

export interface HostedSidecarBinding {
  readonly folder: MapleFolderHandle;
  readonly rawFilename: string;
  readonly filename: string;
  readonly variantId: string;
}

/** The document a write merges over; given explicitly, the store's caches are never consulted. */
export interface SidecarSource {
  readonly passthrough?: PassthroughBucket;
  readonly metadata?: XmpMetadata;
}

export interface PendingSidecarWrite {
  timeout: ReturnType<typeof setTimeout>;
  folder: MapleFolderHandle;
  rawFilename: string;
  model: AdjustmentModel;
  culling: XmpCulling;
  revision: number;
  binding: HostedSidecarBinding;
}

export interface RetryableSidecarWrite {
  folder: MapleFolderHandle;
  rawFilename: string;
  binding: HostedSidecarBinding;
  run: () => Promise<void>;
}

export function primarySidecarFilename(rawFilename: string): string {
  return rawFilename.replace(/\.[^.]+$/, '.xmp');
}

export function sameSidecar(a: HostedSidecarBinding, b: HostedSidecarBinding): boolean {
  return a.folder === b.folder && a.rawFilename === b.rawFilename && a.variantId === b.variantId;
}

export function retriesOutside(
  retries: readonly RetryableSidecarWrite[],
  binding: HostedSidecarBinding,
): RetryableSidecarWrite[] {
  return retries.filter((retry) => !sameSidecar(retry.binding, binding));
}

/** A failed sidecar must not relinquish its folder while sibling streams remain open. */
export async function settleWrites(writes: Iterable<Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(writes);
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Sidecar writes failed after all streams settled');
}
