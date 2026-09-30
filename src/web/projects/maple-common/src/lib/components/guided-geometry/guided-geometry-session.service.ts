import { Injectable, computed, effect, inject, signal, type Signal } from '@angular/core';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import type { GuideFamily } from '../../raw-pipeline/raw-pipeline.guided-geometry';
import type { AdjustmentModel } from '../../models/adjustment-model';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';

export interface GuidePoint {
  x: number;
  y: number;
}
export interface GuideLine {
  start: GuidePoint;
  end: GuidePoint;
}
interface GuideSession {
  assetId: string;
  model: AdjustmentModel;
  adjustment: Signal<AdjustmentModel>;
  family: GuideFamily;
  aspect: number;
}

@Injectable({ providedIn: 'root' })
export class GuidedGeometrySessionService {
  private readonly library = inject(LibraryStateService);
  private readonly editor = inject(EditorStateService);
  private readonly pipeline = inject(RawPipelineService);
  private readonly serializer = inject(XmpSerializerService);
  private readonly canvas = inject(ImageCanvasService);
  private readonly session = signal<GuideSession | null>(null);
  readonly canStart = computed(() => {
    const dims = this.canvas.nativeDimensions();
    return !!this.library.focusedAssetId() && !!dims && dims.w > 0 && dims.h > 0;
  });
  readonly active = computed(() => this.session() !== null);
  readonly family = computed(() => this.session()?.family ?? 'vertical');
  readonly lines = signal<readonly GuideLine[]>([]);
  readonly busy = signal(false);
  readonly message = signal('');
  readonly required = computed(() => (this.family() === 'both' ? 4 : 2));
  readonly canApply = computed(() => this.lines().length === this.required() && !this.busy());
  readonly instruction = computed(() => {
    const direction =
      this.family() === 'both'
        ? this.lines().length < 2
          ? 'vertical'
          : 'horizontal'
        : this.family();
    return `Draw ${direction} guide ${(this.lines().length % 2) + 1} of 2.`;
  });

  constructor() {
    effect(() => {
      const s = this.session();
      if (!s) return;
      if (
        this.library.focusedAssetId() !== s.assetId ||
        this.editor.armedTool() !== 'geometry' ||
        s.adjustment() !== s.model
      )
        this.cancel();
    });
  }

  start(family: GuideFamily): void {
    const id = this.library.focusedAssetId();
    const dims = this.canvas.nativeDimensions();
    if (!id || !dims || dims.w <= 0 || dims.h <= 0) {
      this.message.set('Wait for the image to load before drawing guides.');
      return;
    }
    this.cancel();
    this.editor.endEdit();
    this.canvas.endPeekBefore();
    this.canvas.beforeAfterSplitX.set(null);
    this.canvas.zoomToFit();
    this.message.set('');
    const adjustment = this.library.adjustmentFor(id);
    this.session.set({
      assetId: id,
      model: adjustment(),
      adjustment,
      family,
      aspect: dims.w / dims.h,
    });
  }

  add(line: GuideLine): void {
    if (!this.active() || this.busy() || this.lines().length >= this.required()) return;
    if (Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y) < 0.01) {
      this.message.set('Draw a longer guide along a straight edge.');
      return;
    }
    this.message.set('');
    this.lines.update((lines) => [...lines, line]);
  }

  removeLast(): void {
    if (this.busy()) return;
    this.lines.update((lines) => lines.slice(0, -1));
    this.message.set('');
  }

  cancel(): void {
    this.session.set(null);
    this.lines.set([]);
    this.busy.set(false);
  }

  async apply(): Promise<void> {
    const s = this.session();
    if (!s || !this.canApply()) return;
    this.busy.set(true);
    try {
      const correction = await this.pipeline.solveGuidedGeometry({
        points: this.lines().flatMap((line) => [
          line.start.x,
          line.start.y,
          line.end.x,
          line.end.y,
        ]),
        family: s.family,
        aspect: s.aspect,
        xmp: this.serializer.serialize(s.model),
      });
      // Asset/tool changes and cancellation invalidate even a queued reply.
      if (
        this.session() !== s ||
        this.library.focusedAssetId() !== s.assetId ||
        s.adjustment() !== s.model ||
        this.editor.armedTool() !== 'geometry'
      )
        return;
      const { limited, ...patch } = correction;
      this.cancel();
      this.editor.commit('adjustment', 'Guided geometry');
      this.library.updateAdjustment(s.assetId, patch);
      this.editor.endEdit();
      this.message.set(
        limited
          ? 'Correction reached the geometry slider limits. Fine-tune or redraw the guides.'
          : 'Guided correction applied.',
      );
    } catch (error) {
      if (this.session() === s)
        this.message.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.session() === s) this.busy.set(false);
    }
  }
}
