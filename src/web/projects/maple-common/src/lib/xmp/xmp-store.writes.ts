import { Injectable, inject } from '@angular/core';
import type { AssetId } from '../models/asset';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { HostedRemovalWriterService } from './hosted-removal-writer.service';
import { SidecarFileIoService } from './sidecar-file-io.service';
import { XmpStoreService } from './xmp-store.service';
import type { XmpCulling } from './xmp.types';

/** Serializes confirmed removal commits with the editor's ordinary XMP writes. */
@Injectable({ providedIn: 'root' })
export class XmpRemovalWritesService {
  private readonly store = inject(XmpStoreService);
  private readonly files = inject(SidecarFileIoService);
  private readonly writer = inject(HostedRemovalWriterService);

  async captureRemovalRevision(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
  ): Promise<string> {
    await this.store.settleAsset(assetId);
    return this.files.revision(
      folder,
      this.store.bindingFor(assetId, folder, rawFilename).filename,
    );
  }

  /** The confirmed document carries the model, so a queued scalar save is dropped. */
  async writeRemovalConfirmed(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    model: AdjustmentModel,
    culling: XmpCulling,
    expectedRecords: string,
    records: string,
    expectedRevision?: string,
  ): Promise<string> {
    const binding = this.store.bindingFor(assetId, folder, rawFilename);
    this.store.dropPendingWrite(assetId);
    const output = this.store.publishWorkflow(
      assetId,
      async () =>
        (
          await this.writer.write(
            binding,
            model,
            culling,
            expectedRecords,
            records,
            expectedRevision,
          )
        ).xml,
      () => this.store.bindingFor(assetId, folder, rawFilename).variantId === binding.variantId,
    );
    return this.files.digest(new TextEncoder().encode(await output));
  }
}
