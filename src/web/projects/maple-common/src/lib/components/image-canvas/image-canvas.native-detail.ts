import { NativeDetailSupersededError } from '../../raw-pipeline/raw-pipeline.native-detail.types';
import { signal } from '@angular/core';
import type { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import type { DetailRect } from '../../raw-pipeline/raw-pipeline.native-detail.types';
import { imageDataToBitmap } from '../../raw-pipeline/image-utils';
import type { RenderSizing } from './image-canvas.two-phase';
import {
  containsDetailRect,
  expandDetailRect,
  visibleDetailRect,
  type DetailView,
} from './image-canvas.native-detail.geometry';

export interface DetailBase {
  assetId: string;
  generation: number;
  /** Cold open actually rendered without XMP; displayXmp is its seeded UI model. */
  renderXmp?: string;
  displayXmp: string;
  sizing: RenderSizing;
  filmLut?: ArrayBuffer;
}
export interface DetailOverlay {
  bitmap: ImageBitmap;
  rect: DetailRect;
  nativeW: number;
  nativeH: number;
}
export interface NativeDetailHost {
  readonly pipeline: Pick<RawPipelineService, 'renderNativeDetail' | 'closeNativeDetail'>;
  currentInput(): {
    assetId: string;
    bytes: Uint8Array;
    ext: string;
    generation: number;
    xmp: string;
  } | null;
  /** Null for GPU, crop, before/after, non-RAW, or a zoom below true 100%. */
  detailView(): DetailView | null;
}

/** One patch over the sized CPU base. All asynchronous results are generation guarded. */
export class ImageCanvasNativeDetail {
  readonly overlay = signal<DetailOverlay | null>(null);
  private base: DetailBase | null = null;
  private revision = 0;
  private failedRect: string | null = null;

  constructor(
    private readonly host: NativeDetailHost,
    private readonly toBitmap = imageDataToBitmap,
  ) {}

  visibleOverlay(): DetailOverlay | null {
    return this.base && this.matches(this.base) && this.host.detailView() ? this.overlay() : null;
  }

  recordBase(base: DetailBase): void {
    this.clearPatch();
    this.base = base;
  }

  reset(): void {
    this.clearPatch();
    this.base = null;
    this.host.pipeline.closeNativeDetail();
  }

  private clearPatch(): void {
    this.revision++;
    this.failedRect = null;
    this.overlay()?.bitmap.close();
    this.overlay.set(null);
  }

  private matches(base: DetailBase): boolean {
    const input = this.host.currentInput();
    return (
      !!input &&
      input.assetId === base.assetId &&
      input.generation === base.generation &&
      input.xmp === base.displayXmp
    );
  }

  private requestContext(xmp: string, generation: number) {
    const base = this.base;
    const input = this.host.currentInput();
    const view = this.host.detailView();
    if (
      !base ||
      !input ||
      !view ||
      !this.matches(base) ||
      xmp !== base.displayXmp ||
      generation !== base.generation
    )
      return null;
    return { base, input, view };
  }

  private requestRect(view: DetailView): DetailRect | 'covered' | null {
    const visible = visibleDetailRect(view);
    if (!visible) return null;
    const existing = this.overlay();
    if (existing && containsDetailRect(existing.rect, visible)) return 'covered';
    const rect = expandDetailRect(visible, view.nativeW, view.nativeH);
    if (this.failedRect === JSON.stringify(rect)) return null;
    // A cheap preflight; WASM also counts the real padded develop allocation.
    return rect.width * rect.height > 8 * 1024 * 1024 ? null : rect;
  }

  private isCurrent(base: DetailBase, revision: number): boolean {
    return revision === this.revision && this.matches(base);
  }

  private publish(base: DetailBase, revision: number, overlay: DetailOverlay): void {
    const view = this.host.detailView();
    const visible = view && visibleDetailRect(view);
    if (!this.isCurrent(base, revision) || !visible || !containsDetailRect(overlay.rect, visible)) {
      overlay.bitmap.close();
      return;
    }
    this.overlay()?.bitmap.close();
    this.overlay.set(overlay);
  }

  private failed(error: unknown, revision: number, rect: DetailRect): boolean {
    // Unsupported CFA/stage or allocation budget keeps the sized fallback.
    if (error instanceof NativeDetailSupersededError) return true;
    if (revision === this.revision) this.failedRect = JSON.stringify(rect);
    return false;
  }

  async render(xmp: string, generation: number): Promise<boolean> {
    const context = this.requestContext(xmp, generation);
    if (!context) return false;
    const { base, input, view } = context;
    const rect = this.requestRect(view);
    if (!rect) return false;
    if (rect === 'covered') return true;
    const revision = this.revision;
    try {
      const pixels = await this.host.pipeline.renderNativeDetail({
        sourceId: input.assetId,
        bytes: input.bytes,
        ext: input.ext,
        xmp: base.renderXmp,
        rect,
        maxLongEdge: base.sizing.maxLongEdge,
        qualityPreview: base.sizing.qualityPreview,
        filmLut: base.filmLut,
      });
      if (!this.isCurrent(base, revision)) return true;
      if (pixels.width !== rect.width || pixels.height !== rect.height)
        throw new Error('Invalid native-detail dimensions');
      const bitmap = await this.toBitmap(pixels);
      this.publish(base, revision, { bitmap, rect, nativeW: view.nativeW, nativeH: view.nativeH });
      return true;
    } catch (error) {
      return this.failed(error, revision, rect);
    }
  }
}
