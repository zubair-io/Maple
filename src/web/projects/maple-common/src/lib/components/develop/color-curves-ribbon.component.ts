import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  DestroyRef,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { applyAffine, cropToFullFrameAffine } from '../mask-overlay/mask-geometry';
import { CanvasPickService } from '../image-canvas/canvas-pick.service';
import {
  isIdentityToneCurve,
  type ToneCurve,
  type ToneCurvePoint,
  type AdjustmentModel,
} from '../../models/adjustment-model';
import {
  COLOR_CURVES,
  QUICK_HUE_ANCHORS,
  anyColorCurveModified,
  clampColorCurveY,
  clampColorCurveX,
  colorCurveKeyboardPoint,
  evaluateColorCurve,
  insertColorCurveAnchor,
  lockSkinToneCurve,
  sampleXForCurve,
  type ColorCurveDescriptor,
  type ColorCurveId,
} from './color-curves-math';

interface CurveSampleRequest {
  id: string;
  model: AdjustmentModel;
  xmp: string;
  descriptor: ColorCurveDescriptor;
  generation: number;
}

function nearestKnot(
  points: readonly ToneCurvePoint[],
  point: { x: number; y: number },
  rect: DOMRect,
): number {
  let best = -1;
  let distance = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(
      (points[i][0] - point.x) * rect.width,
      (points[i][1] - point.y) * rect.height,
    );
    if (d < distance) {
      distance = d;
      best = i;
    }
  }
  return distance <= 18 ? best : -1;
}

@Component({
  selector: 'pro-color-curves-ribbon',
  standalone: true,
  templateUrl: './color-curves-ribbon.component.html',
  styleUrl: './color-curves-ribbon.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-full' },
})
export class ColorCurvesRibbonComponent {
  private readonly library = inject(LibraryStateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly editor = inject(EditorStateService);
  private readonly pipeline = inject(RawPipelineService);
  private readonly serializer = inject(XmpSerializerService);
  private readonly pick = inject(CanvasPickService);

  @ViewChild('ribbonSvg') ribbonSvgRef?: ElementRef<SVGSVGElement>;

  readonly curves = COLOR_CURVES;
  readonly quickAnchors = QUICK_HUE_ANCHORS;

  /** False = 8-Band Mixer, True = Color Curves. */
  readonly curvesMode = signal(false);
  readonly activeCurveId = signal<ColorCurveId>('hueVsHue');
  readonly eyedropperActive = signal(false);
  readonly sampleMessage = signal<string | null>(null);

  private draggedKnotIndex: number | null = null;
  private isDragging = false;
  private finishRibbonDrag?: () => void;
  private sampleGeneration = 0;

  constructor() {
    this.destroyRef.onDestroy(() => this.finishRibbonDrag?.());
    effect(() => {
      this.library.focusedAssetId();
      untracked(() => this.cancelEyedropper());
    });
  }

  private cancelEyedropper(): void {
    this.finishRibbonDrag?.();
    this.sampleGeneration++;
    if (this.eyedropperActive()) this.pick.cancel();
    this.eyedropperActive.set(false);
    this.sampleMessage.set(null);
  }

  readonly adj = computed(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)() : null;
  });

  readonly activeDescriptor = computed<ColorCurveDescriptor>(
    () => COLOR_CURVES.find((c) => c.id === this.activeCurveId()) ?? COLOR_CURVES[0],
  );

  readonly activePoints = computed<readonly ToneCurvePoint[]>(() => {
    const a = this.adj();
    const desc = this.activeDescriptor();
    return a ? a[desc.field].points : [];
  });

  readonly isActiveCurveIdentity = computed(() => {
    const a = this.adj();
    const desc = this.activeDescriptor();
    return !a || isIdentityToneCurve(a[desc.field]);
  });

  readonly anyCurveModified = computed(() => anyColorCurveModified(this.adj()));

  readonly svgPathD = computed(() => {
    const desc = this.activeDescriptor();
    const pts = this.activePoints();
    const steps = 96;
    const parts: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const y = evaluateColorCurve(desc, u, pts);
      const sx = (u * 100).toFixed(2);
      const sy = ((1 - y) * 100).toFixed(2);
      parts.push(`${i === 0 ? 'M' : 'L'} ${sx} ${sy}`);
    }
    return parts.join(' ');
  });

  isCurveModified(desc: ColorCurveDescriptor): boolean {
    const a = this.adj();
    return !!a && !isIdentityToneCurve(a[desc.field]);
  }

  setMode(curves: boolean): void {
    if (!curves) this.cancelEyedropper();
    this.curvesMode.set(curves);
  }

  selectCurve(id: ColorCurveId): void {
    this.cancelEyedropper();
    this.activeCurveId.set(id);
    this.sampleMessage.set(null);
  }

  onRibbonPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.isDragging) return;
    const svg = this.ribbonSvgRef?.nativeElement;
    const id = this.library.focusedAssetId();
    if (!svg || !id) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return;

    e.preventDefault();
    const u = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const rawY = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height));
    const desc = this.activeDescriptor();

    this.editor.commit('adjustment', `Edit ${desc.title}`);
    this.isDragging = true;

    this.beginRibbonKnot(desc, id, { x: u, y: rawY }, rect);

    const pointerId = e.pointerId;
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) this.moveRibbonKnot(svg, desc, id, ev);
    };
    const finish = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      this.finishRibbonDrag = undefined;
      if (this.isDragging) {
        this.isDragging = false;
        this.draggedKnotIndex = null;
        this.editor.endEdit();
      }
    };
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) finish();
    };
    this.finishRibbonDrag = finish;

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  removeKnot(index: number, e: Event): void {
    e.stopPropagation();
    const id = this.library.focusedAssetId();
    if (!id) return;
    const desc = this.activeDescriptor();
    const pts = this.activePoints().filter((_, i) => i !== index);
    this.editor.commit('adjustment', `Remove ${desc.title} knot`);
    this.library.updateAdjustment(id, { [desc.field]: { points: pts } });
    this.editor.endEdit();
  }

  onKnotKeyDown(index: number, event: KeyboardEvent): void {
    const id = this.library.focusedAssetId();
    const point = this.activePoints()[index];
    if (!id || !point) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.removeKnot(index, event);
      return;
    }
    const desc = this.activeDescriptor();
    const current = this.activePoints();
    const next = colorCurveKeyboardPoint(desc, current, index, event.key, event.shiftKey);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    if (next[0] === point[0] && next[1] === point[1]) return;
    const points: ToneCurvePoint[] = current.map((p, i) => (i === index ? next : [p[0], p[1]]));
    this.editor.commit('adjustment', `Edit ${desc.title} knot`);
    this.library.updateAdjustment(id, { [desc.field]: { points } });
    this.editor.endEdit();
  }

  private beginRibbonKnot(
    desc: ColorCurveDescriptor,
    id: string,
    point: { x: number; y: number },
    rect: DOMRect,
  ): void {
    const { x: u, y: rawY } = point;
    const pts: ToneCurvePoint[] = this.activePoints().map((p) => [p[0], p[1]]);
    const hitIdx = nearestKnot(pts, { x: u, y: rawY }, rect);
    if (hitIdx >= 0) {
      this.draggedKnotIndex = hitIdx;
    } else {
      const clampedY = clampColorCurveY(desc, u, rawY, pts);
      const seeded = insertColorCurveAnchor({ points: pts }, u, clampedY, desc.isPeriodic).points;
      const center = desc.isPeriodic ? u - Math.floor(u) : u;
      this.draggedKnotIndex = seeded.findIndex((p) => Math.abs(p[0] - center) < 1e-6);
      if (this.draggedKnotIndex >= 0) {
        const x = seeded[this.draggedKnotIndex][0];
        seeded[this.draggedKnotIndex] = [
          x,
          clampColorCurveY(desc, x, clampedY, seeded, this.draggedKnotIndex),
        ];
      }
      this.library.updateAdjustment(id, { [desc.field]: { points: seeded } });
    }
  }

  private moveRibbonKnot(
    svg: SVGSVGElement,
    desc: ColorCurveDescriptor,
    id: string,
    ev: PointerEvent,
  ): void {
    if (this.library.focusedAssetId() !== id || this.activeDescriptor().id !== desc.id) return;
    if (!this.isDragging || this.draggedKnotIndex == null) return;
    const r = svg.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return;
    const curPts: ToneCurvePoint[] = this.activePoints().map((p) => [p[0], p[1]]);
    const idx = this.draggedKnotIndex;
    if (idx < 0 || idx >= curPts.length) return;
    const nextU = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const nextRawY = Math.min(1, Math.max(0, 1 - (ev.clientY - r.top) / r.height));
    const clampedX = clampColorCurveX(desc, nextU, curPts, idx);
    const clampedY = clampColorCurveY(desc, clampedX, nextRawY, curPts, idx);
    curPts[idx] = [clampedX, clampedY];
    this.library.updateAdjustment(id, { [desc.field]: { points: curPts } });
  }

  private editPeriodicCurve(
    label: string,
    transform: (desc: ColorCurveDescriptor, curve: ToneCurve) => ToneCurve,
  ): void {
    const id = this.library.focusedAssetId();
    const a = this.adj();
    if (!id || !a) return;
    const desc = this.activeDescriptor();
    if (!desc.isPeriodic) return;
    this.editor.commit('adjustment', `${label} ${desc.title}`);
    this.library.updateAdjustment(id, { [desc.field]: transform(desc, a[desc.field]) });
    this.editor.endEdit();
  }

  insertQuickAnchor(deg: number): void {
    this.editPeriodicCurve('Anchor', (desc, curve) =>
      insertColorCurveAnchor(curve, deg / 360, 0.5, desc.isPeriodic),
    );
  }

  lockSkinTone(): void {
    this.editPeriodicCurve('Lock skin tone on', (desc, curve) => lockSkinToneCurve(desc, curve));
  }

  resetActiveCurve(): void {
    const id = this.library.focusedAssetId();
    if (!id) return;
    const desc = this.activeDescriptor();
    this.editor.commit('adjustment', `Reset ${desc.title}`);
    this.library.updateAdjustment(id, { [desc.field]: { points: [] } });
    this.editor.endEdit();
  }

  async onEyedropperClick(): Promise<void> {
    if (this.eyedropperActive()) {
      this.cancelEyedropper();
      return;
    }
    const id = this.library.focusedAssetId();
    const a = this.adj();
    if (!id || !a) return;
    const desc = this.activeDescriptor();
    const generation = ++this.sampleGeneration;
    const request = {
      id,
      model: a,
      xmp: this.serializer.serialize(a),
      descriptor: desc,
      generation,
    };
    const prompt = 'Click the photo to place a curve point.';
    this.eyedropperActive.set(true);
    this.sampleMessage.set(prompt);
    try {
      const pt = await this.pick.arm('Click the colour to place a curve anchor');
      if (!pt) {
        this.sampleMessage.set(null);
        return;
      }
      if (!this.sampleIsCurrent(request)) return;
      await this.sampleAnchor(request, pt);
    } catch (err) {
      this.reportSampleError(request, err);
    } finally {
      if (generation === this.sampleGeneration) {
        this.eyedropperActive.set(false);
        if (this.sampleMessage() === prompt)
          this.sampleMessage.set('The photo changed. Pick the colour again.');
      }
    }
  }
  private reportSampleError(request: CurveSampleRequest, error: unknown): void {
    if (!this.sampleIsCurrent(request)) return;
    this.sampleMessage.set(
      error instanceof Error && error.message
        ? error.message
        : 'Could not sample color curve point.',
    );
  }

  private sampleIsCurrent(request: CurveSampleRequest): boolean {
    const current = this.adj();
    return (
      request.generation === this.sampleGeneration &&
      this.library.focusedAssetId() === request.id &&
      this.activeDescriptor().id === request.descriptor.id &&
      current !== null &&
      this.serializer.serialize(current) === request.xmp
    );
  }

  private async sampleAnchor(
    request: CurveSampleRequest,
    pt: { nx: number; ny: number },
  ): Promise<void> {
    const { id, model: a, descriptor: desc } = request;
    const rawBytes = this.library.bytesFor(id) ?? (await this.library.bytesForAsset(id));
    if (!this.sampleIsCurrent(request)) return;
    const asset = this.library.assets().find((item) => item.id === id);
    const ext = asset?.filename.split('.').pop()?.toLowerCase() ?? 'dng';
    const xmp = request.xmp;
    const full = applyAffine(cropToFullFrameAffine(a.crop, asset?.width ?? 1, asset?.height ?? 1), {
      x: pt.nx,
      y: pt.ny,
    });
    const sample = await this.pipeline.sampleColorCurve(rawBytes, ext, xmp, full.x, full.y);
    if (!this.sampleIsCurrent(request)) return;
    const x = sampleXForCurve(desc, sample);
    const current = this.adj()!;
    const next = insertColorCurveAnchor(current[desc.field], x, 0.5, desc.isPeriodic);
    this.editor.commit('adjustment', `Sample ${desc.title}`);
    this.library.updateAdjustment(id, { [desc.field]: next });
    this.editor.endEdit();
    this.sampleMessage.set(null);
  }
}
