import { computed, effect, signal, untracked, type Injector } from '@angular/core';
import type { ImageCanvasComponent } from './image-canvas.component';
import { imageDataToBitmap } from '../../raw-pipeline/image-utils';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { LibraryStore } from '../../state/library-store.service';
import type { XmpAdjustmentRestoreService } from '../../xmp/xmp-adjustment-restore.service';
import type {
  WorkflowVariantSelection,
  WorkflowVariantSelectionService,
} from '../../xmp/workflow-variant-selection.service';

/** One owned session-open comparison image (#4073), independent of live edits. */
export class ImageCanvasComparison {
  readonly bitmap = signal<ImageBitmap | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private readonly baseline = signal<AdjustmentModel | null>(null);
  private readonly retryCount = signal(0);
  private selection: WorkflowVariantSelection | null = null;
  private assetId: string | null = null;
  private initial: AdjustmentModel | null = null;
  private generation = 0;
  private captureGeneration = 0;
  private requested: string | null = null;
  private completed: string | null = null;
  private failed: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly host: ImageCanvasComponent,
    private readonly library: LibraryStore,
    private readonly restore: XmpAdjustmentRestoreService,
    private readonly variants: WorkflowVariantSelectionService,
  ) {}

  wire(injector: Injector): () => void {
    const crop = computed(() => {
      const asset = this.host.state.focusedAsset();
      return asset ? this.host.state.adjustmentFor(asset.id)().crop : null;
    });
    const ready = computed(() => {
      const hasFrame = this.host.gpuPresent.active() || this.host.imageBitmap() !== null;
      return hasFrame && this.host.coldOpenDone;
    });
    const reactive = effect(
      () => {
        const asset = this.host.state.focusedAsset();
        if (!asset) {
          untracked(() => this.reset());
          return;
        }
        const selection = this.variants.current(asset.id);
        const retry = this.retryCount();
        untracked(() => this.select(asset.id, selection));
        const split = this.host.canvasSvc.beforeAfterSplitX();
        const baseline = this.baseline();
        const gpu = this.host.gpuPresent.active();
        const target = Math.min(4096, Math.max(1, this.host.fastTargetPx()));
        if (split === null) {
          untracked(() => this.cancel());
          return;
        }
        if (!baseline || !ready() || !this.host.currentBytes) {
          untracked(() => this.loading.set(this.error() === null));
          return;
        }
        const colorSpace = gpu ? this.host.gpuPresent.colorSpace() : 'srgb';
        if (colorSpace !== 'display-p3' && colorSpace !== 'srgb') {
          untracked(() => {
            this.cancel();
            this.bitmap()?.close();
            this.bitmap.set(null);
            this.error.set('Original preview unavailable');
          });
          return;
        }
        const model = this.library.hydrateAdjustment(asset.id, { ...baseline, crop: crop()! });
        const xmp = this.host.serializeForRender(model);
        const key = JSON.stringify([xmp, target, colorSpace, retry]);
        untracked(() => this.request(key, model, xmp, target, colorSpace));
      },
      { injector },
    );
    return () => {
      reactive.destroy();
      this.reset();
    };
  }

  retry(): void {
    this.error.set(null);
    if (!this.baseline() && this.assetId) void this.capture(this.assetId);
    this.retryCount.update((value) => value + 1);
  }

  private select(id: string, selection: WorkflowVariantSelection): void {
    if (
      id === this.assetId &&
      selection.scope === this.selection?.scope &&
      selection.variantId === this.selection?.variantId
    )
      return;
    this.reset();
    this.assetId = id;
    this.selection = selection;
    this.initial = structuredClone(this.host.state.adjustmentFor(id)());
    void this.capture(id);
  }

  private async openingModel(id: string): Promise<AdjustmentModel> {
    const addressable = id.includes(':') && !id.startsWith('fs:');
    if (this.library.backend !== 'self-hosted' || !addressable) return this.initial!;
    const sidecar = await this.restore.loadForWrite(id);
    return sidecar === undefined
      ? this.initial!
      : { ...defaultAdjustmentModel(), ...(sidecar?.model ?? {}) };
  }

  private async capture(id: string): Promise<void> {
    const generation = ++this.captureGeneration;
    try {
      // Join the real cold XMP read rather than freezing a pre-hydration default
      // or a later edited model. Hosted folders already hydrate before focus.
      const model = await this.openingModel(id);
      if (generation === this.captureGeneration) this.baseline.set(structuredClone(model));
    } catch {
      if (generation === this.captureGeneration) {
        this.loading.set(false);
        this.error.set('Original preview unavailable');
      }
    }
  }

  private request(
    key: string,
    model: AdjustmentModel,
    xmp: string,
    target: number,
    colorSpace: 'display-p3' | 'srgb',
  ): void {
    if (this.completed === key && this.bitmap()) return;
    if (this.requested === key || this.failed === key) return;
    this.cancel();
    this.requested = key;
    this.bitmap()?.close();
    this.bitmap.set(null);
    this.error.set(null);
    this.loading.set(true);
    const generation = this.generation;
    const bytes = this.host.currentBytes!;
    const ext = this.host.currentExt;
    // Crop/viewport bursts coalesce; exposure and other live slider ticks keep
    // the same key and never decode or cross the WASM boundary for comparison.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.render(key, generation, model, xmp, target, colorSpace, bytes, ext);
    }, 150);
  }

  private async render(
    key: string,
    generation: number,
    model: AdjustmentModel,
    xmp: string,
    target: number,
    colorSpace: 'display-p3' | 'srgb',
    bytes: Uint8Array,
    ext: string,
  ): Promise<void> {
    try {
      const film = model.filmLook ? await this.host.filmLut.getLattice(model.filmLook) : null;
      if (generation !== this.generation) return;
      if (model.filmLook && !film) throw new Error('Original film look unavailable');
      const bitmap = await this.renderBitmap(bytes, ext, xmp, target, colorSpace, film);
      if (generation !== this.generation) {
        bitmap.close();
        return;
      }
      this.bitmap.set(bitmap);
      this.completed = key;
    } catch {
      if (generation === this.generation) {
        this.failed = key;
        this.error.set('Original preview unavailable');
      }
    } finally {
      if (generation === this.generation) {
        this.requested = null;
        this.loading.set(false);
      }
    }
  }

  private async renderBitmap(
    bytes: Uint8Array,
    ext: string,
    xmp: string,
    target: number,
    colorSpace: 'display-p3' | 'srgb',
    film: ArrayBuffer | null,
  ): Promise<ImageBitmap> {
    if (colorSpace === 'display-p3') {
      // Reuse the bounded CPU reference and its lossless, ICC-tagged output;
      // GPU presentation retains its independent live scene and textures.
      const rendered = await this.host.pipeline.exportImage(
        bytes,
        ext,
        { format: 'png', quality: 100, colorSpace, maxSidePixels: target },
        xmp,
        film ?? undefined,
      );
      return createImageBitmap(rendered.blob);
    }
    // Sized CPU RAW and browser-developed non-RAW share the existing sRGB
    // preview entry. Non-RAW ignores the decode cap: bound its owned bitmap.
    const decoded = await this.host.pipeline.decode(
      bytes,
      ext,
      xmp,
      target,
      false,
      film ?? undefined,
    );
    const full = await imageDataToBitmap(decoded);
    const scale = Math.min(1, target / Math.max(full.width, full.height));
    if (scale === 1) return full;
    try {
      return await createImageBitmap(full, {
        resizeWidth: Math.max(1, Math.round(full.width * scale)),
        resizeHeight: Math.max(1, Math.round(full.height * scale)),
        resizeQuality: 'high',
      });
    } finally {
      full.close();
    }
  }

  private cancel(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.requested = null;
    this.loading.set(false);
  }

  private reset(): void {
    this.cancel();
    this.captureGeneration++;
    this.bitmap()?.close();
    this.bitmap.set(null);
    this.baseline.set(null);
    this.completed = null;
    this.failed = null;
    this.error.set(null);
    this.assetId = null;
    this.selection = null;
    this.initial = null;
  }
}
