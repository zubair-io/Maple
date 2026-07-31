// WbPadComponent — 2-D white balance pad widget (#1540, Pro Editor M2).
//
// X-axis: temperature [2000..12000 K] (blue→amber left→right).
// Y-axis: tint [-150..150] (green→magenta bottom→top; ACR's crs:Tint span, #1870).
//
// The pad fill is a CSS gradient composition of both axes so the puck
// position reads as a colour.
//
// Draggable white puck + crosshair wires to temperature + tint.
// Kelvin readout ("5260 K") + Tint value in the corner.
//
// Eyedropper button: samples a pixel from the canvas (via ImageCanvasService)
// and computes neutral WB (temperature + tint) via a rough log-ratio heuristic
// (rgbToWb) — not the Robertson CCT method.

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
export { xToTemp, tempToX, yToTint, tintToY, rgbToWb } from './wb-pad-math';
import { xToTemp, tempToX, yToTint, tintToY, rgbToWb } from './wb-pad-math';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';
import type { AdjustmentModel } from '../../models/adjustment-model';
import { ADJUSTMENT_RANGES } from '../../generated/adjustment-model.generated';

const [TEMP_MIN, TEMP_MAX] = ADJUSTMENT_RANGES.temperature;
const [TINT_MIN, TINT_MAX] = ADJUSTMENT_RANGES.tint;

/** Clamp a value to a closed `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

@Component({
  selector: 'pro-wb-pad',
  standalone: true,
  imports: [],
  templateUrl: './wb-pad.component.html',
  styleUrl: './wb-pad.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WbPadComponent implements AfterViewInit, OnDestroy {
  @ViewChild('padEl') padRef!: ElementRef<HTMLElement>;

  private library = inject(LibraryStateService);
  private canvasSvc = inject(ImageCanvasService);
  private injector = inject(Injector);
  private cleanupEffect?: () => void;

  /** Eyedropper active (sampling mode). */
  readonly eyedropperActive = signal(false);

  private readonly adj = computed<AdjustmentModel | null>(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)() : null;
  });

  /** Puck position as [x, y] fractions [0..1]. */
  readonly puckPos = computed<{ x: number; y: number }>(() => {
    const adj = this.adj();
    const temp = adj?.temperature ?? 6500;
    const tint = adj?.tint ?? 0;
    return { x: tempToX(temp), y: tintToY(tint) };
  });

  // Read-side clamp (#2412): the puck position is already implicitly
  // clamped by tempToX/tintToY, but a value already persisted to a sidecar
  // out of range (e.g. by a build that predates the keyboard-stepper clamp
  // fix) would otherwise show a raw, out-of-range Kelvin/tint readout here.
  // Clamp on read so the numeric labels always agree with what the puck
  // shows and with the declared ADJUSTMENT_RANGES.
  readonly tempLabel = computed<string>(() => {
    const adj = this.adj();
    const temp = clamp(adj?.temperature ?? 6500, TEMP_MIN, TEMP_MAX);
    return `${temp} K`;
  });

  readonly tintLabel = computed<string>(() => {
    const adj = this.adj();
    const t = clamp(adj?.tint ?? 0, TINT_MIN, TINT_MAX);
    return t >= 0 ? `+${t}` : `${t}`;
  });

  // ── Drag state ─────────────────────────────────────────────────────────────
  private _moveHandler: ((e: PointerEvent) => void) | null = null;
  private _upHandler: (() => void) | null = null;

  ngAfterViewInit(): void {
    const e = effect(
      () => {
        this.puckPos();
      },
      { injector: this.injector },
    );
    this.cleanupEffect = () => e.destroy();
  }

  ngOnDestroy(): void {
    this.cleanupEffect?.();
    this._releaseDrag();
  }

  onPadPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const pad = this.padRef?.nativeElement;
    if (!pad) return;
    this._applyPointerPos(e);
    this._moveHandler = (ev: PointerEvent) => this._applyPointerPos(ev);
    this._upHandler = () => this._releaseDrag();
    window.addEventListener('pointermove', this._moveHandler);
    window.addEventListener('pointerup', this._upHandler);
    pad.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private _applyPointerPos(e: PointerEvent): void {
    const pad = this.padRef?.nativeElement;
    if (!pad) return;
    const rect = pad.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    const temp = xToTemp(x);
    const tint = yToTint(y);
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.library.updateAdjustment(id, { temperature: temp, tint });
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

  // ── Eyedropper ─────────────────────────────────────────────────────────────

  onEyedropperClick(): void {
    const pixels = this.canvasSvc.currentPixels();
    if (!pixels) {
      this.eyedropperActive.set(false);
      return;
    }

    // Sample the centre pixel of the decoded image.
    // DecodedImage.rgb is a Uint8Array of RGB triplets (no alpha channel).
    const img = pixels as DecodedImage;
    const cx = Math.floor(img.width / 2);
    const cy = Math.floor(img.height / 2);
    const idx = (cy * img.width + cx) * 3;
    const r = img.rgb[idx] ?? 128;
    const g = img.rgb[idx + 1] ?? 128;
    const b = img.rgb[idx + 2] ?? 128;

    const { temperature, tint } = rgbToWb(r, g, b);
    const id = this.library.focusedAssetId();
    if (id) {
      this.library.updateAdjustment(id, { temperature, tint });
    }
    this.eyedropperActive.set(false);
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────

  onPadKeyDown(e: KeyboardEvent): void {
    const TEMP_STEP = 100; // K per arrow press
    const TINT_STEP = 1; // tint unit per arrow press
    const id = this.library.focusedAssetId();
    if (!id) return;

    const adj = this.adj();
    const temp = adj?.temperature ?? 6500;
    const tint = adj?.tint ?? 0;

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        this.library.updateAdjustment(id, {
          temperature: clamp(temp - TEMP_STEP, TEMP_MIN, TEMP_MAX),
          tint,
        });
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.library.updateAdjustment(id, {
          temperature: clamp(temp + TEMP_STEP, TEMP_MIN, TEMP_MAX),
          tint,
        });
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.library.updateAdjustment(id, {
          temperature: temp,
          tint: clamp(tint - TINT_STEP, TINT_MIN, TINT_MAX),
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.library.updateAdjustment(id, {
          temperature: temp,
          tint: clamp(tint + TINT_STEP, TINT_MIN, TINT_MAX),
        });
        break;
    }
  }
}
