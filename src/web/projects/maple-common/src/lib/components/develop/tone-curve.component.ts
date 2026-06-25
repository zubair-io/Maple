// ToneCurveComponent — parametric tone curve widget (#1540, Pro Editor M2).
//
// Square plot on --pro-canvas-alt with:
//   - Faint 25/50/75 grid lines
//   - Dashed identity diagonal
//   - Ghost luma histogram fill behind the curve
//   - Accent-coloured cubic spline through the 4 parametric control points
//   - 4 draggable 9px discs (accent rim when modified) mapping
//     parametricShadows / parametricDarks / parametricLights / parametricHighlights
//
// Channel selector: Luma (default) active; R · G · B shown but inert —
// per-channel point curves are not in AdjustmentModel yet (#1542).
// CLAUDE.md §6: no fake R/G/B controls.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { computeRgbHistograms } from '../../raw-pipeline/image-utils';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';
import type { AdjustmentModel } from '../../models/adjustment-model';
import { ADJUSTMENT_RANGES } from '../../models/adjustment-model';
export { paramToYOffset, evalSpline } from './tone-curve-math';
import { paramToYOffset, evalSpline } from './tone-curve-math';

export type CurveChannel = 'luma' | 'r' | 'g' | 'b';

// The 4 PV2012 parametric control points.
const PARAM_RANGE = ADJUSTMENT_RANGES.parametricHighlights; // [-100, 100]

interface CtrlPt {
  /** Normalised x position [0..1] on the curve (fixed per region). */
  x: number;
  field: keyof Pick<
    AdjustmentModel,
    'parametricShadows' | 'parametricDarks' | 'parametricLights' | 'parametricHighlights'
  >;
  label: string;
}

const CTRL_PTS: readonly CtrlPt[] = [
  { x: 0.125, field: 'parametricShadows', label: 'Shadows' },
  { x: 0.375, field: 'parametricDarks', label: 'Darks' },
  { x: 0.625, field: 'parametricLights', label: 'Lights' },
  { x: 0.875, field: 'parametricHighlights', label: 'Highlights' },
];

@Component({
  selector: 'pro-tone-curve',
  standalone: true,
  imports: [],
  templateUrl: './tone-curve.component.html',
  styleUrl: './tone-curve.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToneCurveComponent implements AfterViewInit, OnDestroy {
  @ViewChild('plotCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  private library = inject(LibraryStateService);
  private canvasSvc = inject(ImageCanvasService);
  private injector = inject(Injector);
  private cleanupEffect?: () => void;

  readonly activeChannel = signal<CurveChannel>('luma');

  readonly channels: Array<{ id: CurveChannel; label: string }> = [
    { id: 'luma', label: 'Luma' },
    // R/G/B: per-channel point curves not in AdjustmentModel — tracked in #1542.
    { id: 'r', label: 'R' },
    { id: 'g', label: 'G' },
    { id: 'b', label: 'B' },
  ];

  private readonly adj = computed<AdjustmentModel | null>(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)() : null;
  });

  /** Histogram recomputed only when the decoded-pixel buffer changes, not on every drag tick. */
  private readonly _histogram = computed(() => {
    const pixels = this.canvasSvc.currentPixels();
    if (!pixels) return null;
    return computeRgbHistograms(pixels as DecodedImage);
  });

  readonly controlPoints = computed(() => {
    const adj = this.adj();
    return CTRL_PTS.map((cp) => {
      const raw = adj ? (adj[cp.field] as number) : 0;
      const offset = paramToYOffset(raw);
      return { x: cp.x, y: Math.max(0, Math.min(1, cp.x + offset)) };
    });
  });

  // ── Drag state ────────────────────────────────────────────────────────────
  private _dragIdx: number | null = null;
  private _dragStartY = 0;
  private _dragStartVal = 0;
  private _cachedPlotH = 0;
  private _moveHandler: ((e: PointerEvent) => void) | null = null;
  private _upHandler: (() => void) | null = null;

  ngAfterViewInit(): void {
    const e = effect(
      () => {
        this.controlPoints();
        this._histogram();
        this._render();
      },
      { injector: this.injector },
    );
    this.cleanupEffect = () => e.destroy();
  }

  ngOnDestroy(): void {
    this.cleanupEffect?.();
    this._releaseDrag();
  }

  setChannel(ch: CurveChannel): void {
    if (ch === 'luma') this.activeChannel.set(ch);
    // R/G/B blocked — no model fields (#1542).
  }

  onPlotPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const pad = this._pad(rect.width);
    const plotW = rect.width - pad * 2;
    const plotH = rect.height - pad * 2;
    this._cachedPlotH = plotH;

    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const pts = this.controlPoints();

    let best = -1;
    let bestDist = 22;
    for (let i = 0; i < pts.length; i++) {
      const cx = pad + pts[i].x * plotW;
      const cy = pad + (1 - pts[i].y) * plotH;
      const d = Math.hypot(mx - cx, my - cy);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best === -1) return;

    this._dragIdx = best;
    this._dragStartY = e.clientY;
    const adj = this.adj();
    this._dragStartVal = adj ? (adj[CTRL_PTS[best].field] as number) : 0;

    this._moveHandler = (ev: PointerEvent) => this._onMove(ev);
    this._upHandler = () => this._onUp();
    window.addEventListener('pointermove', this._moveHandler);
    window.addEventListener('pointerup', this._upHandler);
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private _onMove(e: PointerEvent): void {
    if (this._dragIdx === null || this._cachedPlotH <= 0) return;
    const dy = this._dragStartY - e.clientY;
    const raw = this._dragStartVal + (dy / this._cachedPlotH) * 200;
    const [lo, hi] = PARAM_RANGE;
    const v = Math.min(hi, Math.max(lo, Math.round(raw)));
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.library.updateAdjustment(id, {
      [CTRL_PTS[this._dragIdx].field]: v,
    } as Partial<AdjustmentModel>);
  }

  private _onUp(): void {
    this._dragIdx = null;
    this._releaseDrag();
  }

  private _releaseDrag(): void {
    if (this._moveHandler) {
      window.removeEventListener('pointermove', this._moveHandler);
      this._moveHandler = null;
    }
    if (this._upHandler) {
      window.removeEventListener('pointerup', this._upHandler);
      this._upHandler = null;
    }
  }

  private _pad(w: number): number {
    return Math.round(w * 0.06);
  }

  private _render(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const W = Math.round(rect.width * dpr);
    const H = Math.round(rect.height * dpr);
    if (W <= 0 || H <= 0) return;
    canvas.width = W;
    canvas.height = H;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const pad = this._pad(w);
    const plotW = w - pad * 2;
    const plotH = h - pad * 2;

    ctx.fillStyle = '#08070a';
    ctx.fillRect(0, 0, w, h);

    // Ghost histogram — reads pre-computed cache; only recomputes when pixel buffer changes.
    const hist = this._histogram();
    if (hist) {
      const { luma } = hist;
      let peak = 1;
      for (let i = 0; i < 256; i++) peak = Math.max(peak, luma[i]);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      const bw = plotW / 256;
      for (let i = 0; i < 256; i++) {
        const bh = (luma[i] / peak) * plotH * 0.88;
        ctx.fillRect(pad + i * bw, pad + plotH - bh, Math.max(1, bw), bh);
      }
    }

    // Grid lines (25 / 50 / 75)
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    for (const f of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(pad + f * plotW, pad);
      ctx.lineTo(pad + f * plotW, pad + plotH);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pad, pad + f * plotH);
      ctx.lineTo(pad + plotW, pad + f * plotH);
      ctx.stroke();
    }

    // Identity diagonal (dashed)
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 0.75;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(pad, pad + plotH);
    ctx.lineTo(pad + plotW, pad);
    ctx.stroke();
    ctx.setLineDash([]);

    // Spline
    const pts = this.controlPoints();
    ctx.strokeStyle = '#c4493a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const steps = 120;
    for (let i = 0; i <= steps; i++) {
      const x = i / steps;
      const y = evalSpline(pts, x);
      const px = pad + x * plotW;
      const py = pad + (1 - y) * plotH;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Control discs
    const adj = this.adj();
    for (let i = 0; i < pts.length; i++) {
      const px = pad + pts[i].x * plotW;
      const py = pad + (1 - pts[i].y) * plotH;
      const val = adj ? (adj[CTRL_PTS[i].field] as number) : 0;
      const modified = Math.abs(val) > 0.5;

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = modified ? '#c4493a' : 'rgba(255,255,255,0.30)';
      ctx.lineWidth = modified ? 1.5 : 1;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
