// ToneCurveComponent — tone curve panel (#1540 → #367).
//
// Two families of tone control on one surface, matching
// `docs/xmp-canonical-format.md` § "Tone curves" and the two shapes `AdjustmentModel` carries:
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
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { computeRgbHistograms } from '../../raw-pipeline/image-utils';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';
import type { AdjustmentModel, ToneCurveMode, ToneCurvePoint } from '../../models/adjustment-model';
import { MuiLivingSliderComponent } from '../../ui/living-slider/mui-living-slider.component';
import { hitTest, insertPoint, movePoint, removePoint } from './tone-curve-edit';
import {
  DEFAULT_HIGHLIGHT_SPLIT,
  DEFAULT_MIDTONE_SPLIT,
  DEFAULT_SHADOW_SPLIT,
  clampParametricSplit,
  defaultSplitValue,
  regionForSplitHandle,
  type ParametricSplitHandle,
} from './tone-curve-splits';
import {
  HIT_RADIUS,
  buildToneCurveViewModel,
  type ChannelTab,
  type CurveChannel,
  type CurveFamily,
  type CurveModeTab,
  type FamilyTab,
  type ParametricSlider,
  type PlottedKnot,
} from './tone-curve.vm';

/** Nudge per arrow-key press, in authoring-domain units. */
const KEY_STEP = 1 / 64;

/** Arrow keys → unit nudge vector in the authoring domain (y runs up). */
const NUDGE_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

/** Keys that delete the focused knot. */
const DELETE_KEYS: ReadonlySet<string> = new Set(['Delete', 'Backspace']);

@Component({
  selector: 'pro-tone-curve',
  standalone: true,
  imports: [MuiLivingSliderComponent],
  templateUrl: './tone-curve.component.html',
  styleUrl: './tone-curve.component.scss',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToneCurveComponent implements OnDestroy {
  @ViewChild('plot') plotRef?: ElementRef<SVGSVGElement>;

  private readonly library = inject(LibraryStateService);
  private readonly editor = inject(EditorStateService);
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
  private detachSplitDrag: (() => void) | null = null;
  private rafHandle: number | null = null;
  private pendingWrite: readonly ToneCurvePoint[] | null = null;
  private detachDrag: (() => void) | null = null;

  ngOnDestroy(): void {
    this.endDrag();
    this.detachSplitDrag?.();
  }

  // ── Family selector (#2232) ─────────────────────────────────────────────

  selectFamily(tab: FamilyTab): void {
    this.vm.family.set(tab.id);
    this.vm.selectedKnotIndex.set(null);
  }

  isActiveFamily(id: CurveFamily): boolean {
    return this.vm.family() === id;
  }

  // ── Mode selector (#5039) ───────────────────────────────────────────────

  selectMode(tab: CurveModeTab): void {
    this.discretePatch({ toneCurveMode: tab.id }, 'Tone curve mode');
  }

  isActiveMode(id: ToneCurveMode): boolean {
    return this.vm.toneCurveMode() === id;
  }

  // ── Channel selector ────────────────────────────────────────────────────

  selectChannel(tab: ChannelTab): void {
    this.vm.channel.set(tab.id);
    this.vm.selectedKnotIndex.set(null);
  }

  isActiveChannel(id: CurveChannel): boolean {
    return this.vm.channel() === id;
  }

  /** Mutually-exclusive color/border pair for the channel tab's active
   * state (Tailwind port #3071) — folded into one computed string rather
   * than a base class plus a conditional add-on. */
  protected channelTabClass(active: boolean): string {
    return active
      ? 'bg-[color:var(--pro-accent-28)] border-[color:var(--pro-accent)] text-[color:var(--pro-accent)]'
      : 'bg-transparent border-transparent text-[color:var(--pro-text-dim)]';
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

    this.editor.commit('adjustment', 'Tone curve point');
    this.dragIndex = index;
    this.vm.selectedKnotIndex.set(index);
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
    this.vm.selectedKnotIndex.set(null);
    this.commit(removePoint(this.vm.points(), knot.index));
  }

  deleteSelectedKnot(): void {
    const selected = this.vm.selectedKnot();
    if (!selected || selected.pinned) return;
    this.vm.selectedKnotIndex.set(null);
    this.commit(removePoint(this.vm.points(), selected.index));
  }

  onKnotFocus(knot: PlottedKnot): void {
    this.vm.selectedKnotIndex.set(knot.index);
  }

  /**
   * Arrow keys nudge the focused knot; Delete/Backspace removes it.
   *
   * Only a key the editor actually consumed suppresses the browser
   * default — an unhandled key, and Delete on a pinned endpoint, fall
   * through so scrolling and Back still work.
   */
  onKnotKeyDown(knot: PlottedKnot, event: KeyboardEvent): void {
    if (this.applyKnotKey(knot, event)) event.preventDefault();
  }

  /** Apply one key to the focused knot; `true` when it was consumed. */
  private applyKnotKey(knot: PlottedKnot, event: KeyboardEvent): boolean {
    const points = this.vm.points();
    const nudge = NUDGE_KEYS[event.key];
    if (nudge) {
      const [x, y] = points[knot.index] ?? this.knotPosition(knot);
      const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
      this.commit(movePoint(points, knot.index, x + nudge[0] * step, y + nudge[1] * step));
      return true;
    }
    if (DELETE_KEYS.has(event.key) && !knot.pinned) {
      this.vm.selectedKnotIndex.set(null);
      this.commit(removePoint(points, knot.index));
      return true;
    }
    return false;
  }

  /** A plotted knot back in the authoring domain — the pre-layout fallback. */
  private knotPosition(knot: PlottedKnot): ToneCurvePoint {
    return [knot.cx / this.vm.plotSize, 1 - knot.cy / this.vm.plotSize];
  }

  /** Reset the active channel's curve back to identity (the empty list). */
  resetChannel(): void {
    this.vm.selectedKnotIndex.set(null);
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
    const active = this.dragIndex !== null;
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
    if (active) this.editor.endEdit();
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
    this.editor.commit('adjustment', 'Tone curve point');
    this.writeCurve(points);
    this.editor.endEdit();
  }

  private writeCurve(points: readonly ToneCurvePoint[]): void {
    this.patch({ [this.vm.activeTab().field]: { points: [...points] } });
  }

  // ── Parametric sliders & split handles (#5039) ──────────────────────────

  parametricValue(slider: ParametricSlider): number {
    return this.vm.parametricValue(slider.field);
  }

  onParametricStart(slider: ParametricSlider): void {
    this.editor.commit('adjustment', slider.label);
  }

  onParametricEnd(): void {
    this.editor.endEdit();
  }

  onParametricChange(slider: ParametricSlider, value: number): void {
    this.vm.activeRegion.set(slider.field);
    this.patch({ [slider.field]: value });
  }

  onParametricReset(slider: ParametricSlider): void {
    this.vm.activeRegion.set(null);
    this.discretePatch({ [slider.field]: 0 }, `Reset ${slider.label}`);
  }

  onParametricEnter(slider: ParametricSlider): void {
    this.vm.activeRegion.set(slider.field);
  }

  onParametricLeave(): void {
    this.vm.activeRegion.set(null);
  }

  onSplitPointerDown(handle: ParametricSplitHandle, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    this.detachSplitDrag?.();
    this.editor.commit('adjustment', 'Tone curve split');
    this.vm.activeRegion.set(regionForSplitHandle(handle));

    const updateFromEvent = (e: PointerEvent) => {
      const pos = this.toAuthoring(e);
      if (!pos) return;
      this.applySplitValue(handle, pos.x * 100);
    };

    const move = (e: PointerEvent) => updateFromEvent(e);
    const up = () => {
      if (this.detachSplitDrag !== up) return;
      this.detachSplitDrag = null;
      this.editor.endEdit();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.vm.activeRegion.set(null);
    };
    this.detachSplitDrag = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  onSplitDoubleClick(handle: ParametricSplitHandle, event: MouseEvent): void {
    event.stopPropagation();
    this.editor.commit('adjustment', 'Reset tone curve split');
    this.applySplitValue(handle, defaultSplitValue(handle));
    this.editor.endEdit();
  }

  onSplitKeyDown(handle: ParametricSplitHandle, event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 5 : 1);
    const current =
      handle === 'shadow'
        ? this.vm.shadowSplit()
        : handle === 'midtone'
          ? this.vm.midtoneSplit()
          : this.vm.highlightSplit();
    this.editor.commit('adjustment', 'Tone curve split');
    this.applySplitValue(handle, current + delta);
    this.editor.endEdit();
  }

  resetSplits(): void {
    this.discretePatch(
      {
        parametricShadowSplit: DEFAULT_SHADOW_SPLIT,
        parametricMidtoneSplit: DEFAULT_MIDTONE_SPLIT,
        parametricHighlightSplit: DEFAULT_HIGHLIGHT_SPLIT,
      },
      'Reset tone curve splits',
    );
  }

  private applySplitValue(handle: ParametricSplitHandle, proposed: number): void {
    const clamped = clampParametricSplit(
      handle,
      proposed,
      this.vm.shadowSplit(),
      this.vm.midtoneSplit(),
      this.vm.highlightSplit(),
    );
    const field =
      handle === 'shadow'
        ? 'parametricShadowSplit'
        : handle === 'midtone'
          ? 'parametricMidtoneSplit'
          : 'parametricHighlightSplit';
    this.patch({ [field]: clamped });
  }

  // ── Shared plumbing ─────────────────────────────────────────────────────

  private discretePatch(fields: Partial<AdjustmentModel>, label: string): void {
    this.editor.commit('adjustment', label);
    this.patch(fields);
    this.editor.endEdit();
  }

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
