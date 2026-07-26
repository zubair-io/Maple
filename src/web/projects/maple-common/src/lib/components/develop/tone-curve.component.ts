// ToneCurveComponent — tone curve panel (#1540 → #367).
//
// Two families of tone control on one surface, matching
// `docs/maple-paper.md` § 3 and the two shapes `AdjustmentModel` carries:
//
//   * Four PARAMETRIC region sliders (`parametric{Highlights,Lights,
//     Darks,Shadows}`), ±100 each, driving the stage's synthesised
//     five-knot polyline.
//   * Four per-channel POINT curves (`toneCurve{Luma,Red,Green,Blue}`),
//     authored on the square plot and switched by the channel selector.
//
// The plot is SVG rather than a canvas so every knot is a real DOM node
// with its own accessible name and keyboard focus. A `<canvas>` disc
// cannot be announced or tabbed to, and the curve editor is the one
// control in the editor where "the third point from the left" is the
// only way to say what you are grabbing.
//
// Before #367 this component drew the four PARAMETRIC values as draggable
// discs on the plot and rendered R/G/B as disabled tabs, because the
// point-curve fields did not exist on `AdjustmentModel` yet. #366 landed
// the fields and #365 their sidecar I/O, so the plot now edits the real
// point curves and the parametric values moved to labelled sliders,
// where they can be read, nudged and reset individually.
//
// ## Render-tick budget
//
// A point-curve edit CANNOT ride the 19-scalar GPU fast path — the
// stripped develop prefix has no curve slot, so `canUseLiveFastPath`
// rejects it (see `image-canvas.live-params.ts`) and the tick routes
// through the full `render(xmp)` path: serialize, parse, re-run the
// chain. Issuing one of those per `pointermove` would put several round
// trips inside a single frame on a high-rate pointer. So a drag paints
// from `dragOverride` — a local signal the plot reads directly — while
// the MODEL write is coalesced to at most one per animation frame, with
// a final flush on pointer-up so the committed curve is exactly where
// the user let go.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  inject,
} from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { computeRgbHistograms } from '../../raw-pipeline/image-utils';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';
import type { AdjustmentModel, ToneCurvePoint } from '../../models/adjustment-model';
import { LivingSliderComponent } from './living-slider.component';
import { hitTest, insertPoint, movePoint, removePoint } from './tone-curve-edit';
import {
  HIT_RADIUS,
  buildToneCurveViewModel,
  type ChannelTab,
  type CurveChannel,
  type ParametricSlider,
  type PlottedKnot,
} from './tone-curve.vm';

/** Vertical nudge per arrow-key press, in authoring-domain units. */
const KEY_STEP = 1 / 64;

@Component({
  selector: 'pro-tone-curve',
  standalone: true,
  imports: [LivingSliderComponent],
  templateUrl: './tone-curve.component.html',
  styleUrl: './tone-curve.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToneCurveComponent implements OnDestroy {
  @ViewChild('plot') plotRef?: ElementRef<SVGSVGElement>;

  private readonly library = inject(LibraryStateService);
  private readonly canvasSvc = inject(ImageCanvasService);

  private readonly adj = computed<AdjustmentModel | null>(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)() : null;
  });

  /** Recomputed only when the decoded pixel buffer changes, not per tick. */
  private readonly lumaHistogram = computed<Uint32Array | null>(() => {
    const pixels = this.canvasSvc.currentPixels();
    return pixels ? computeRgbHistograms(pixels as DecodedImage).luma : null;
  });

  protected readonly vm = buildToneCurveViewModel(this.adj, this.lumaHistogram);

  // ── Drag state ──────────────────────────────────────────────────────────
  private dragIndex: number | null = null;
  private rafHandle: number | null = null;
  private pendingWrite: readonly ToneCurvePoint[] | null = null;
  private detachDrag: (() => void) | null = null;

  ngOnDestroy(): void {
    this.endDrag();
  }

  // ── Channel selector ────────────────────────────────────────────────────

  selectChannel(tab: ChannelTab): void {
    this.vm.channel.set(tab.id);
  }

  isActiveChannel(id: CurveChannel): boolean {
    return this.vm.channel() === id;
  }

  // ── Point editing ───────────────────────────────────────────────────────

  /**
   * Pointer-down on the plot: grab the knot under the cursor, or insert
   * one there and grab that. Either way the gesture continues on the
   * window, so a fast drag that leaves the plot keeps tracking.
   */
  onPlotPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const pos = this.toAuthoring(event);
    if (!pos) return;

    const existing = hitTest(this.vm.points(), pos.x, pos.y, HIT_RADIUS);
    const next = existing >= 0 ? this.vm.points() : insertPoint(this.vm.points(), pos.x, pos.y);
    const index = existing >= 0 ? existing : hitTest(next, pos.x, pos.y, HIT_RADIUS);
    if (index < 0) return;

    this.dragIndex = index;
    this.vm.dragOverride.set(next);
    if (existing < 0) this.queueWrite(next);

    const move = (e: PointerEvent) => this.onDragMove(e);
    const up = () => this.endDrag();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    this.detachDrag = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    event.preventDefault();
  }

  /** Double-click a knot to delete it; endpoints ignore the gesture. */
  onKnotDoubleClick(knot: PlottedKnot, event: MouseEvent): void {
    event.stopPropagation();
    if (knot.pinned) return;
    this.commit(removePoint(this.vm.points(), knot.index));
  }

  /** Arrow keys nudge the focused knot; Delete/Backspace removes it. */
  onKnotKeyDown(knot: PlottedKnot, event: KeyboardEvent): void {
    const points = this.vm.points();
    const current = points[knot.index] ?? [
      knot.cx / this.vm.plotSize,
      1 - knot.cy / this.vm.plotSize,
    ];
    const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const dy = event.key === 'ArrowUp' ? step : -step;
      this.commit(movePoint(points, knot.index, current[0], current[1] + dy));
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const dx = event.key === 'ArrowRight' ? step : -step;
      this.commit(movePoint(points, knot.index, current[0] + dx, current[1]));
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (knot.pinned) return;
      this.commit(removePoint(points, knot.index));
    } else {
      return;
    }
    event.preventDefault();
  }

  /** Reset the active channel's curve back to identity (the empty list). */
  resetChannel(): void {
    this.commit([]);
  }

  private onDragMove(event: PointerEvent): void {
    if (this.dragIndex === null) return;
    const pos = this.toAuthoring(event);
    if (!pos) return;
    const next = movePoint(this.vm.points(), this.dragIndex, pos.x, pos.y);
    // Paint immediately off the override; write to the model at most
    // once per frame (see the class doc).
    this.vm.dragOverride.set(next);
    this.queueWrite(next);
  }

  private endDrag(): void {
    this.detachDrag?.();
    this.detachDrag = null;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    // Flush whatever the last frame did not carry, so the committed
    // curve is exactly where the pointer was released.
    const pending = this.pendingWrite;
    this.pendingWrite = null;
    this.dragIndex = null;
    if (pending) this.writeCurve(pending);
    this.vm.dragOverride.set(null);
  }

  /** Coalesce model writes to one per animation frame. */
  private queueWrite(points: readonly ToneCurvePoint[]): void {
    this.pendingWrite = points;
    if (this.rafHandle !== null) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      const next = this.pendingWrite;
      this.pendingWrite = null;
      if (next) this.writeCurve(next);
    });
  }

  /** Write and clear any drag override — used by the discrete edits. */
  private commit(points: readonly ToneCurvePoint[]): void {
    this.vm.dragOverride.set(null);
    this.writeCurve(points);
  }

  private writeCurve(points: readonly ToneCurvePoint[]): void {
    this.patch({ [this.vm.activeTab().field]: { points: [...points] } });
  }

  // ── Parametric sliders ──────────────────────────────────────────────────

  parametricValue(slider: ParametricSlider): number {
    return this.vm.parametricValue(slider.field);
  }

  onParametricChange(slider: ParametricSlider, value: number): void {
    this.patch({ [slider.field]: value });
  }

  onParametricReset(slider: ParametricSlider): void {
    this.patch({ [slider.field]: 0 });
  }

  // ── Shared plumbing ─────────────────────────────────────────────────────

  private patch(fields: Partial<AdjustmentModel>): void {
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.library.updateAdjustment(id, fields);
  }

  /** Client coordinates → authoring domain, or `null` before layout. */
  private toAuthoring(event: PointerEvent): { x: number; y: number } | null {
    const el = this.plotRef?.nativeElement;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: 1 - (event.clientY - rect.top) / rect.height,
    };
  }
}
