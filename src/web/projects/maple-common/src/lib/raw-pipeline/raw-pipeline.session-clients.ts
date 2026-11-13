import { NativeDetailClient } from './raw-pipeline.native-detail';
import type { NativeDetailArgs, NativeDetailPixels } from './raw-pipeline.native-detail.types';
import type { PendingHandler } from './raw-pipeline.service-internals';
import { RemovalAuthoringClient } from './raw-pipeline.removal-client';
import { SavedRemovalPreviewClient } from './raw-pipeline.saved-preview';

/** Own source-scoped editor sessions that share the worker's decode lifetime. */
export class RawPipelineSessionClients {
  readonly removal: RemovalAuthoringClient;
  readonly savedPreview: SavedRemovalPreviewClient;
  private readonly savedPreviewSource: RemovalAuthoringClient;
  private readonly detail: NativeDetailClient;

  constructor(
    worker: () => Worker,
    nextId: () => number,
    pending: Map<number, PendingHandler>,
    sampleQueue: <T>(run: () => Promise<T>) => Promise<T>,
  ) {
    this.removal = new RemovalAuthoringClient(worker, nextId, pending);
    this.savedPreviewSource = new RemovalAuthoringClient(worker, nextId, pending);
    this.savedPreview = new SavedRemovalPreviewClient(this.savedPreviewSource, sampleQueue);
    this.detail = new NativeDetailClient(worker, nextId, pending);
  }

  nativeDetailRevision(): number {
    return this.detail.revision();
  }

  renderNativeDetail(args: NativeDetailArgs, revision: number): Promise<NativeDetailPixels> {
    return this.detail.render(args, revision);
  }

  closeNativeDetail(worker: Worker | null): void {
    this.savedPreview.close();
    if (this.removal.isOpen) return this.detail.detach();
    const authoring = this.removal.releaseRetainedSource();
    const savedPreview = this.savedPreviewSource.releaseRetainedSource();
    this.detail.close(authoring || savedPreview ? worker : null);
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
