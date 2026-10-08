import { effect, type Injector } from '@angular/core';
import type { ImageCanvasComponent } from './image-canvas.component';
import type {
  WorkflowVariantSelection,
  WorkflowVariantSelectionService,
} from '../../xmp/workflow-variant-selection.service';
import type { AdjustmentModel } from '../../models/adjustment-model';
import type { Asset } from '../../models/asset';
import { settleFailedAutoFit } from './image-canvas.fit-failure';
import { ImageCanvasVariantPreviews } from './image-canvas.variant-previews';
import { MaskSessionService } from '../mask-overlay/mask-session.service';

/** Branch selection shares the existing RAW/live session and invalidates late render publications. */
export class ImageCanvasAdjustmentEffect {
  private selection: WorkflowVariantSelection | null = null;
  private brushRasters: number | null = null;
  private readonly previews = new ImageCanvasVariantPreviews();
  constructor(
    private readonly host: ImageCanvasComponent,
    private readonly variants: WorkflowVariantSelectionService,
  ) {}

  wire(injector: Injector): () => void {
    // The root mask session owns the effect that re-registers a loaded sidecar's brush
    // rasters (#360); it must exist for every render, not only once the mask tool is armed.
    const masks = injector.get(MaskSessionService);
    const reactive = effect(
      () => {
        const brushRasters = masks.brush.rasterRevision();
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
        if (asset.id !== host.currentAssetId) return;
        if (this.settleUnavailableSource(asset) || !host.currentBytes) return;
        if (!host.coldOpenDone) {
          this.restartColdOpen(changed, asset.id, asset.filename);
          return;
        }
        this.syncFilm(asset, model);
        if (this.isCurrentRender(xmp, brushRasters)) return;
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
  /** Whether `xmp` is already on screen. A brush raster landing leaves the
   *  sidecar unchanged but still needs a render. */
  private isCurrentRender(xmp: string, brushRasters: number): boolean {
    const landed = this.brushRasters !== null && brushRasters !== this.brushRasters;
    this.brushRasters = brushRasters;
    return xmp === this.host.lastRenderedXmp && !landed;
  }

  reset(): void {
    this.selection = null;
    this.brushRasters = null;
    this.previews.clear();
  }

  private syncFilm(asset: Asset, model: AdjustmentModel): void {
    const gpuActive = this.host.gpuPresent.active();
    this.host.filmSync.syncIfNeeded(asset.id, model.filmLook, gpuActive);
    if (!gpuActive) this.host.filmSync.ensureCpuLutResolving(asset.id, model.filmLook);
  }

  private settleUnavailableSource(asset: Asset): boolean {
    const host = this.host;
    const unavailable = host.currentBytes
      ? this.failedColdPresentation(asset)
      : host.byteLoadError()?.id === asset.id ||
        (!asset.absPath && !asset.id.includes(':') && !host.state.bytesFor(asset.id));
    if (!unavailable) return false;
    settleFailedAutoFit(
      host,
      asset.id,
      host.renderGeneration,
      host.state.autoFitRevisionFor(asset.id),
    );
    return true;
  }

  private failedColdPresentation(asset: Asset): boolean {
    const error = this.host.byteLoadError();
    return (
      error?.id === asset.id &&
      error.renderGeneration === this.host.renderGeneration &&
      !this.host.coldOpenDone
    );
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
