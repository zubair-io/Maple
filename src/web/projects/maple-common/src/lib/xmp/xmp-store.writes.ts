import type { AssetId } from '../models/asset';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import type { HostedRemovalWriterService } from './hosted-removal-writer.service';
import type { HostedSidecarBinding } from './hosted-sidecar-bindings.service';
import type { SidecarFileIoService } from './sidecar-file-io.service';
import type { SidecarSaveStateService } from './sidecar-save-state.service';
import type { XmpParserService } from './xmp-parser.service';
import type { PassthroughBucket, XmpCulling } from './xmp.types';

/** Serializes confirmed removal commits with the editor's ordinary XMP writes. */
export class XmpStoreWrites {
  constructor(
    private readonly files: SidecarFileIoService,
    private readonly writer: HostedRemovalWriterService,
    private readonly saveState: SidecarSaveStateService,
    private readonly parser: XmpParserService,
    private readonly inFlight: Map<AssetId, Promise<void>>,
    private readonly settle: (assetId: AssetId) => Promise<void>,
    private readonly needsFlush: (assetId: AssetId) => boolean,
    private readonly bindingFor: (
      assetId: AssetId,
      folder: MapleFolderHandle,
      rawFilename: string,
    ) => HostedSidecarBinding,
    private readonly flush: (assetId: AssetId) => Promise<void>,
    private readonly clearPending: (assetId: AssetId) => void,
    private readonly rememberPassthrough: (
      assetId: AssetId,
      passthrough: PassthroughBucket,
    ) => void,
  ) {}

  async publishWorkflow(
    assetId: AssetId,
    publish: () => Promise<string>,
    currentSource: () => boolean,
    rememberMetadata: (
      assetId: AssetId,
      value: ReturnType<XmpParserService['parseAdjustmentModel']>['metadata'],
    ) => void,
  ): Promise<string> {
    await this.settle(assetId);
    const revision = this.saveState.queued(assetId);
    const prior = this.inFlight.get(assetId) ?? Promise.resolve();
    const write = prior.then(async () => {
      this.saveState.saving(assetId, revision);
      try {
        const output = await publish();
        if (currentSource()) {
          const parsed = this.parser.parseAdjustmentModel(output);
          this.rememberPassthrough(assetId, parsed.passthrough);
          rememberMetadata(assetId, parsed.metadata);
        }
        this.saveState.saved(assetId, revision);
        return output;
      } catch (error) {
        this.saveState.failed(assetId, revision, error);
        throw error;
      }
    });
    const barrier = write.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.set(assetId, barrier);
    try {
      return await write;
    } finally {
      if (this.inFlight.get(assetId) === barrier) this.inFlight.delete(assetId);
    }
  }

  async captureRevision(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
  ): Promise<string> {
    if (this.needsFlush(assetId)) await this.flush(assetId);
    return this.files.revision(folder, this.bindingFor(assetId, folder, rawFilename).filename);
  }

  async writeConfirmed(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    model: AdjustmentModel,
    culling: XmpCulling,
    expectedRecords: string,
    records: string,
    expectedRevision?: string,
  ): Promise<string> {
    const binding = this.bindingFor(assetId, folder, rawFilename);
    this.clearPending(assetId);
    const revision = this.saveState.queued(assetId);
    const prior = this.inFlight.get(assetId) ?? Promise.resolve();
    let confirmedRevision = '';
    const write = prior
      .catch(() => undefined)
      .then(async () => {
        this.saveState.saving(assetId, revision);
        try {
          const output = await this.writer.write(
            binding,
            model,
            culling,
            expectedRecords,
            records,
            expectedRevision,
          );
          confirmedRevision = output.revision;
          if (this.bindingFor(assetId, folder, rawFilename).variantId === binding.variantId)
            this.rememberPassthrough(assetId, output.passthrough);
          this.saveState.saved(assetId, revision);
        } catch (error) {
          this.saveState.failed(assetId, revision, error);
          throw error;
        }
      })
      .finally(() => {
        if (this.inFlight.get(assetId) === write) this.inFlight.delete(assetId);
      });
    this.inFlight.set(assetId, write);
    await write;
    return confirmedRevision;
  }
}
