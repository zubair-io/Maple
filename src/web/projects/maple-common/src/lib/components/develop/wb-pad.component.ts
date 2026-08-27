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

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { MuiPad2dComponent } from '../../ui/pad-2d/mui-pad-2d.component';
import type { MuiPad2dValue } from '../../ui/pad-2d/mui-pad-2d.component';
import { xToTemp, tempToX, yToTint, tintToY, rgbToWb } from './wb-pad-math';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';
import type { AdjustmentModel } from '../../models/adjustment-model';
import { ADJUSTMENT_RANGES } from '../../generated/adjustment-tables.generated';

const [TEMP_MIN, TEMP_MAX] = ADJUSTMENT_RANGES.temperature;
const [TINT_MIN, TINT_MAX] = ADJUSTMENT_RANGES.tint;

/** Clamp a value to a closed `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

@Component({
  selector: 'pro-wb-pad',
  standalone: true,
  imports: [MuiPad2dComponent],
  templateUrl: './wb-pad.component.html',
  styleUrl: './wb-pad.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WbPadComponent {
  private library = inject(LibraryStateService);
  private canvasSvc = inject(ImageCanvasService);

  /** Eyedropper active (sampling mode). */
  readonly eyedropperActive = signal(false);

  private readonly adj = computed<AdjustmentModel | null>(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)() : null;
  });

  /** Puck position in `mui-pad-2d`'s normalized `[-1, 1]` domain, converted
   *  from the `[0, 1]` fraction `tempToX`/`tintToY` return (`frac*2 - 1`). */
  readonly padValue = computed<MuiPad2dValue>(() => {
    const adj = this.adj();
    const temp = adj?.temperature ?? 6500;
    const tint = adj?.tint ?? 0;
    return { x: tempToX(temp) * 2 - 1, y: tintToY(tint) * 2 - 1 };
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

  /** `mui-pad-2d`'s drag/click value, converted back from `[-1, 1]` into the
   *  `[0, 1]` fraction `xToTemp`/`yToTint` expect (`(v+1)/2`) — the inverse
   *  of `padValue` above. Pointer-capture drag and click-to-jump both route
   *  through this single handler (mui-pad-2d's own `PointerCaptureDragBase`
   *  wiring), same end effect as the pointer-drag path this replaces. */
  onPadValueChange(v: MuiPad2dValue): void {
    const id = this.library.focusedAssetId();
    if (!id) return;
    const temp = xToTemp((v.x + 1) / 2);
    const tint = yToTint((v.y + 1) / 2);
    this.library.updateAdjustment(id, { temperature: temp, tint });
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

  // fallow-ignore-next-line complexity
  onPadKeyDown(e: KeyboardEvent): void {
    const TEMP_STEP = 100; // K per arrow press
    const TINT_STEP = 1; // tint unit per arrow press
    const id = this.library.focusedAssetId();
    if (!id) return;

    // Clamp BOTH axes at read (#2412 review): every keyboard update writes
    // both fields back, so a pre-existing out-of-range value on the
    // non-stepped axis (e.g. tint=180 persisted by a build that predates the
    // stepper clamp) must be normalized here too — otherwise ArrowLeft/Right
    // would keep re-persisting the bad tint verbatim.
    const adj = this.adj();
    const temp = clamp(adj?.temperature ?? 6500, TEMP_MIN, TEMP_MAX);
    const tint = clamp(adj?.tint ?? 0, TINT_MIN, TINT_MAX);

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
