// Immutable hosted file selection shared by queued scalar and removal writers (#4063).
import { Injectable, inject } from '@angular/core';
import type { AssetId } from '../models/asset';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { WorkflowXmpService } from './workflow-xmp.service';
import { WorkflowVariantStoreService } from './workflow-variant-store.service';
import { PRIMARY_VARIANT_ID } from '../generated/workflow.generated';

export interface HostedSidecarBinding {
  readonly folder: MapleFolderHandle;
  readonly rawFilename: string;
  readonly filename: string;
  readonly variantId: string;
}
@Injectable({ providedIn: 'root' })
export class HostedSidecarBindingsService {
  private readonly core = inject(WorkflowXmpService);
  private readonly variants = inject(WorkflowVariantStoreService);
  private readonly selected = new Map<AssetId, HostedSidecarBinding>();

  async bind(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    variantId: string,
    currentSource: () => boolean,
  ): Promise<string | null> {
    if (!folder.native || !folder.write || !navigator.locks)
      throw Error('Reopen this folder with filesystem write access before selecting a variant.');
    const primary = rawFilename.replace(/\.[^.]+$/, '.xmp');
    const filename = await this.core.variantFilename(primary, variantId);
    const xml = await this.variants.read(folder, primary, variantId);
    if (!currentSource()) throw Error('The editor source changed while loading this variant.');
    this.selected.set(assetId, { folder, rawFilename, filename, variantId });
    return xml;
  }

  get(assetId: AssetId, folder: MapleFolderHandle, rawFilename: string): HostedSidecarBinding {
    const selected = this.selected.get(assetId);
    return selected?.folder === folder && selected.rawFilename === rawFilename
      ? selected
      : {
          folder,
          rawFilename,
          filename: rawFilename.replace(/\.[^.]+$/, '.xmp'),
          variantId: PRIMARY_VARIANT_ID,
        };
  }
}
