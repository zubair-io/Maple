import { effect, type Injector } from '@angular/core';
import type { ImageCanvasComponent } from './image-canvas.component';
import type {
  WorkflowVariantSelection,
  WorkflowVariantSelectionService,
} from '../../xmp/workflow-variant-selection.service';
import { ImageCanvasVariantPreviews } from './image-canvas.variant-previews';

/** Branch selection shares the existing RAW/live session and invalidates late render publications. */
export class ImageCanvasAdjustmentEffect {
  private selection: WorkflowVariantSelection | null = null;
  private readonly previews = new ImageCanvasVariantPreviews();
  constructor(
    private readonly host: ImageCanvasComponent,
    private readonly variants: WorkflowVariantSelectionService,
  ) {}

  wire(injector: Injector): () => void {
    const reactive = effect(
      () => {
        const host = this.host;
        const asset = host.state.focusedAsset();
        if (!asset) {
          this.reset();
          return;
        }
        const selection = this.variants.current(asset.id);
        const model = host.state.adjustmentFor(asset.id)();
        const xmp = host.serializeForRender(model);
        const changed = this.changed(selection);
        const previous = this.selection;
        this.selection = selection;
        if (!host.currentBytes || asset.id !== host.currentAssetId) return;
        if (!host.coldOpenDone) {
          this.restartColdOpen(changed, asset.id, asset.filename);
          return;
        }
        host.filmSync.syncIfNeeded(asset.id, model.filmLook, host.gpuPresent.active());
        if (!host.gpuPresent.active())
          host.filmSync.ensureCpuLutResolving(asset.id, model.filmLook);
        if (xmp === host.lastRenderedXmp) return;
        if (changed && !host.gpuPresent.active())
          this.restorePreview(previous!, selection, asset.id, xmp);
        host.scheduleRerender(xmp);
      },
      { injector },
    );
    return () => {
      reactive.destroy();
      this.reset();
    };
  }
  reset(): void {
    this.selection = null;
    this.previews.clear();
  }

  private restartColdOpen(changed: boolean, id: string, filename: string): void {
    if (!changed || !this.host.currentBytes) return;
    this.host.renderGeneration++;
    this.host.clearRerenderTimers();
    this.host.gpuPresent.teardown();
    void this.host.loadReal(id, filename, this.host.currentBytes);
  }
  private changed(next: WorkflowVariantSelection): boolean {
    return (
      this.selection !== null &&
      (this.selection.scope !== next.scope || this.selection.variantId !== next.variantId)
    );
  }
  private restorePreview(
    previous: WorkflowVariantSelection,
    selection: WorkflowVariantSelection,
    id: string,
    xmp: string,
  ): void {
    const host = this.host;
    const bytes = host.currentBytes!;
    const width = host.fastTargetPx();
    const old = host.imageBitmap();
    if (old && host.lastRenderedXmp) {
      this.previews.store({
        selection: previous,
        id,
        bytes,
        width,
        bitmap: old,
        xmp: host.lastRenderedXmp,
      });
    } else old?.close();
    const bitmap = this.previews.take({ selection, id, bytes, xmp, width });
    host.imageBitmap.set(bitmap);
    host.canvasSvc.currentPixels.set(null);
    if (bitmap) host.recordPaintedDims(bitmap.width, bitmap.height);
  }
}
