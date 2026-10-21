import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { CanvasPickService } from '../image-canvas/canvas-pick.service';
import { isIdentityToneCurve, type ToneCurvePoint } from '../../models/adjustment-model';
import {
  COLOR_CURVES,
  QUICK_HUE_ANCHORS,
  anyColorCurveModified,
  clampColorCurveY,
  evaluateColorCurve,
  insertColorCurveAnchor,
  lockSkinToneCurve,
  sampleXForCurve,
  type ColorCurveDescriptor,
  type ColorCurveId,
} from './color-curves-math';

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
    if (!curves && this.eyedropperActive()) {
      this.pick.cancel();
      this.eyedropperActive.set(false);
    }
    this.curvesMode.set(curves);
  }

  selectCurve(id: ColorCurveId): void {
    this.activeCurveId.set(id);
    this.sampleMessage.set(null);
  }

  onRibbonPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const svg = this.ribbonSvgRef?.nativeElement;
    const id = this.library.focusedAssetId();
    if (!svg || !id) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return;

    e.preventDefault();
    const u = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const rawY = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height));
    const desc = this.activeDescriptor();
    const pts: ToneCurvePoint[] = this.activePoints().map((p) => [p[0], p[1]]);

    this.editor.commit('adjustment', `Edit ${desc.title}`);
    this.isDragging = true;

    let hitIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = (pts[i][0] - u) * rect.width;
      const dy = (pts[i][1] - rawY) * rect.height;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        hitIdx = i;
      }
    }

    if (hitIdx >= 0 && bestDist <= 18) {
      this.draggedKnotIndex = hitIdx;
    } else {
      const clampedY = clampColorCurveY(desc, u, rawY, pts);
      pts.push([u, clampedY]);
      pts.sort((a, b) => a[0] - b[0]);
      this.draggedKnotIndex = pts.findIndex((p) => Math.abs(p[0] - u) < 1e-6);
      this.library.updateAdjustment(id, { [desc.field]: { points: pts } });
    }

    const onMove = (ev: PointerEvent): void => {
      if (!this.isDragging || this.draggedKnotIndex == null) return;
      const r = svg.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return;
      const curPts: ToneCurvePoint[] = this.activePoints().map((p) => [p[0], p[1]]);
      const idx = this.draggedKnotIndex;
      if (idx < 0 || idx >= curPts.length) return;
      const nextU = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const nextRawY = Math.min(1, Math.max(0, 1 - (ev.clientY - r.top) / r.height));
      const minX = idx > 0 ? curPts[idx - 1][0] + 0.01 : 0;
      const maxX = idx + 1 < curPts.length ? curPts[idx + 1][0] - 0.01 : 1;
      const clampedX = Math.min(maxX, Math.max(minX, nextU));
      const clampedY = clampColorCurveY(desc, clampedX, nextRawY, curPts, idx);
      curPts[idx] = [clampedX, clampedY];
      this.library.updateAdjustment(id, { [desc.field]: { points: curPts } });
    };

    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (this.isDragging) {
        this.isDragging = false;
        this.draggedKnotIndex = null;
        this.editor.endEdit();
      }
    };

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

  insertQuickAnchor(deg: number): void {
    const id = this.library.focusedAssetId();
    const a = this.adj();
    if (!id || !a) return;
    const desc = this.activeDescriptor();
    if (!desc.isPeriodic) return;
    const next = insertColorCurveAnchor(a[desc.field], deg / 360, 0.5);
    this.editor.commit('adjustment', `Anchor ${desc.title}`);
    this.library.updateAdjustment(id, { [desc.field]: next });
    this.editor.endEdit();
  }

  lockSkinTone(): void {
    const id = this.library.focusedAssetId();
    const a = this.adj();
    if (!id || !a) return;
    const desc = this.activeDescriptor();
    if (!desc.isPeriodic) return;
    const next = lockSkinToneCurve(desc, a[desc.field]);
    this.editor.commit('adjustment', `Lock skin tone on ${desc.title}`);
    this.library.updateAdjustment(id, { [desc.field]: next });
    this.editor.endEdit();
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
      this.pick.cancel();
      this.eyedropperActive.set(false);
      this.sampleMessage.set(null);
      return;
    }
    this.eyedropperActive.set(true);
    this.sampleMessage.set('Click the photo to place a stage-input anchor.');
    const pt = await this.pick.arm('Click the colour to place a curve anchor');
    this.eyedropperActive.set(false);
    if (!pt) {
      this.sampleMessage.set(null);
      return;
    }
    const id = this.library.focusedAssetId();
    const a = this.adj();
    if (!id || !a) return;
    try {
      const rawBytes = this.library.bytesFor(id) ?? (await this.library.bytesForAsset(id));
      const asset = this.library.assets().find((item) => item.id === id);
      const ext = asset?.filename.split('.').pop()?.toLowerCase() ?? 'dng';
      const xmp = this.serializer.serialize(a);
      const sample = await this.pipeline.sampleColorCurve(rawBytes, ext, xmp, pt.nx, pt.ny);
      const desc = this.activeDescriptor();
      const x = sampleXForCurve(desc, sample);
      const next = insertColorCurveAnchor(a[desc.field], x, 0.5);
      this.editor.commit('adjustment', `Sample ${desc.title}`);
      this.library.updateAdjustment(id, { [desc.field]: next });
      this.editor.endEdit();
      this.sampleMessage.set(null);
    } catch {
      this.sampleMessage.set('Could not sample color curve point.');
    }
  }
}
