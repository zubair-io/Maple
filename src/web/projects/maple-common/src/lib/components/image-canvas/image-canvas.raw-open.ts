import type { WritableSignal } from '@angular/core';
import type { AssetId } from '../../models/asset';
import type { EmbeddedPreviewService } from '../../raw-pipeline/embedded-preview.service';
import { isNonRawExtension } from '../../state/raw-extensions';
import { settleFailedAutoFit } from './image-canvas.fit-failure';
import type { ByteLoadError } from './image-canvas.byteload';
import { editorInput, type EditorInput } from './image-canvas.input';
import { coldOpen2d, type Render2dHost } from './image-canvas.render2d';

interface RawOpenDependencies {
  readonly embeddedPreview: Pick<EmbeddedPreviewService, 'extractEmbeddedPreview'>;
  readonly byteLoadError: WritableSignal<ByteLoadError | null>;
  readonly imageBitmap: WritableSignal<ImageBitmap | null>;
  readonly currentAssetId: () => AssetId | null;
  readonly coldOpenDone: () => boolean;
  readonly gpuEnabled: () => boolean;
  readonly openGpu: (assetId: AssetId, bytes: Uint8Array, ext: string) => Promise<boolean>;
  readonly setCurrentInput: (bytes: Uint8Array, ext: string) => void;
  readonly recordPaintedDims: (width: number, height: number) => void;
}

/** Coordinates embedded-preview presentation with the final GPU/CPU RAW open. */
export class ImageCanvasRawOpen {
  private loadGeneration = 0;
  private provisionalAssetId: AssetId | null = null;

  constructor(
    private readonly host: Render2dHost,
    private readonly deps: RawOpenDependencies,
  ) {}

  reset(): void {
    this.loadGeneration++;
    this.provisionalAssetId = null;
  }

  hasProvisionalPreview(assetId: AssetId): boolean {
    return this.provisionalAssetId === assetId;
  }

  clearProvisionalPreview(assetId: AssetId): void {
    if (this.provisionalAssetId === assetId) this.provisionalAssetId = null;
  }

  async load(assetId: AssetId, filename: string, bytes: Uint8Array): Promise<void> {
    const request = ++this.loadGeneration;
    this.deps.byteLoadError.set(null);
    const sourceExt = filename.split('.').pop()?.toLowerCase() ?? '';
    if (!isNonRawExtension(sourceExt) && sourceExt !== 'x3f') {
      void this.showEmbeddedPreview(assetId, bytes, sourceExt);
    }

    const input = await this.normalizeInput(assetId, filename, bytes, request);
    if (!input || !this.ownsLoad(assetId, request)) return;
    this.deps.setCurrentInput(input.bytes, input.ext);
    if (this.deps.gpuEnabled() && !isNonRawExtension(input.ext)) {
      if (await this.deps.openGpu(assetId, input.bytes, input.ext)) {
        this.discardProvisionalPreview(assetId);
        return;
      }
    }
    await this.openCpuInput(assetId, filename, input, request);
  }

  private async openCpuInput(
    assetId: AssetId,
    filename: string,
    input: EditorInput,
    request: number,
  ): Promise<void> {
    const generation = this.host.renderGeneration;
    const presented = await coldOpen2d(this.host, assetId, filename, input.ext, input.bytes, () =>
      this.ownsLoad(assetId, request),
    );
    if (
      presented === false &&
      this.ownsLoad(assetId, request) &&
      generation === this.host.renderGeneration
    ) {
      this.deps.byteLoadError.set({
        id: assetId,
        filename,
        reason: 'Image could not be rendered; retry or choose another image',
        renderGeneration: generation,
      });
    }
  }

  private ownsLoad(assetId: AssetId, request: number): boolean {
    return request === this.loadGeneration && assetId === this.deps.currentAssetId();
  }

  private normalizeInput(
    assetId: AssetId,
    filename: string,
    bytes: Uint8Array,
    request: number,
  ): Promise<EditorInput | null> {
    return editorInput(filename, bytes, this.deps.embeddedPreview).catch((error: unknown) => {
      if (this.ownsLoad(assetId, request)) {
        console.error('[image-canvas] input normalization failed:', error);
        this.deps.byteLoadError.set({
          id: assetId,
          filename,
          reason: 'Embedded preview unavailable; retry or choose another image',
        });
        settleFailedAutoFit(
          this.host,
          assetId,
          this.host.renderGeneration,
          this.host.state.autoFitRevisionFor(assetId),
        );
      }
      return null;
    });
  }

  private async showEmbeddedPreview(
    assetId: AssetId,
    bytes: Uint8Array,
    ext: string,
  ): Promise<void> {
    try {
      const preview = await this.deps.embeddedPreview.extractEmbeddedPreview(bytes, ext);
      if (assetId !== this.deps.currentAssetId() || this.deps.coldOpenDone()) return;

      const bitmap = await createImageBitmap(preview.blob);
      if (assetId !== this.deps.currentAssetId() || this.deps.coldOpenDone()) {
        bitmap.close();
        return;
      }

      this.deps.imageBitmap()?.close();
      this.deps.imageBitmap.set(bitmap);
      this.host.canvasSvc.currentPixels.set(null);
      this.deps.recordPaintedDims(preview.width, preview.height);
      this.provisionalAssetId = assetId;
    } catch {
      // A RAW without an embedded preview simply stays on the normal decode path.
    }
  }

  private discardProvisionalPreview(assetId: AssetId): void {
    if (this.provisionalAssetId !== assetId) return;
    this.deps.imageBitmap()?.close();
    this.deps.imageBitmap.set(null);
    this.provisionalAssetId = null;
  }
}
