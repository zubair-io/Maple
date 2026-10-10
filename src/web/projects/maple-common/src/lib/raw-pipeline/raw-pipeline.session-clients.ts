import { NativeDetailClient } from './raw-pipeline.native-detail';
import type { NativeDetailArgs, NativeDetailPixels } from './raw-pipeline.native-detail.types';
import type { PendingHandler } from './raw-pipeline.service-internals';
import { RemovalAuthoringClient } from './raw-pipeline.removal-client';
import { SavedRemovalPreviewClient } from './raw-pipeline.saved-preview';

/** Own source-scoped editor sessions that share the worker's decode lifetime. */
export class RawPipelineSessionClients {
  readonly removal: RemovalAuthoringClient;
  readonly savedPreview: SavedRemovalPreviewClient;
  private readonly detail: NativeDetailClient;

  constructor(
    worker: () => Worker,
    nextId: () => number,
    pending: Map<number, PendingHandler>,
    sampleQueue: <T>(run: () => Promise<T>) => Promise<T>,
  ) {
    this.removal = new RemovalAuthoringClient(worker, nextId, pending);
    this.savedPreview = new SavedRemovalPreviewClient(
      new RemovalAuthoringClient(worker, nextId, pending),
      sampleQueue,
    );
    this.detail = new NativeDetailClient(worker, nextId, pending);
  }

  renderNativeDetail(args: NativeDetailArgs): Promise<NativeDetailPixels> {
    const revision = this.detail.revision();
    return this.detail.render(args, revision);
  }

  closeNativeDetail(worker: Worker | null): void {
    this.savedPreview.close();
    if (this.removal.isOpen) this.detail.detach();
    else this.detail.close(worker);
  }

  workerFailed(): void {
    this.detail.workerFailed();
    this.close();
  }

  close(): void {
    this.removal.close();
    this.savedPreview.close();
  }
}
