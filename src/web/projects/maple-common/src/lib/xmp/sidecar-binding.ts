// Sidecar write bookkeeping shared with XmpStoreService; extracted to keep
// the store under the file-size budget.
import { VIDEO_EXTENSIONS } from '../state/no-preview-extensions';
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
  /** Exact document read for a confirmed batch target; null means no sidecar existed. */
  readonly document?: string | null;
}

/** The unknown content a write preserves: a batch target's own source, else what the store cached. */
export function writtenSource(
  source: SidecarSource | undefined,
  cachedPassthrough: PassthroughBucket | undefined,
  cachedMetadata: XmpMetadata | undefined,
): SidecarSource {
  const passthrough = source ? source.passthrough : cachedPassthrough;
  return {
    passthrough,
    metadata: passthrough ? undefined : source ? source.metadata : cachedMetadata,
  };
}

/** A published sidecar; `reconciled` when it merged onto a document changed since the writer read it (#4983). */
export interface SidecarWrite {
  readonly xml: string;
  readonly reconciled: boolean;
}

/** What the live editor adopts after a reconciled save without scheduling another one. */
export interface MergedSidecar {
  readonly assetId: string;
  readonly binding: HostedSidecarBinding;
  readonly xml: string;
  /** The model and culling this write published, before the merge. */
  readonly saved: { readonly model: AdjustmentModel; readonly culling: XmpCulling };
  /** A newer edit is queued; it must continue from the adopted document. */
  readonly pending: boolean;
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
  const leafStart = Math.max(rawFilename.lastIndexOf('/'), rawFilename.lastIndexOf('\\')) + 1;
  const dot = rawFilename.lastIndexOf('.');
  const stemEnd = dot > leafStart ? dot : rawFilename.length;
  const extension = dot > leafStart ? rawFilename.slice(dot + 1).toLowerCase() : '';
  if (VIDEO_EXTENSIONS.has(extension)) return `${rawFilename}.xmp`;
  return rawFilename.slice(0, stemEnd) + '.xmp';
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
