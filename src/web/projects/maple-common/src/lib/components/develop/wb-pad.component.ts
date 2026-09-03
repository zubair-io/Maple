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
// Eyedropper button (#2434): arms the canvas's pick overlay, then hands the
// clicked point to raw-core's neutral sampler through the render worker. The
// result is applied as one committed, undoable action carrying its own
// provenance — which point was picked, and which version of the derivation
// produced the pair. The old in-component `rgbToWb` log-ratio heuristic
// (single centre pixel, no clip guard) is gone; the pad's own drag/keyboard
// paths are unchanged.

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { MuiPad2dComponent } from '../../ui/pad-2d/mui-pad-2d.component';
import type { MuiPad2dValue } from '../../ui/pad-2d/mui-pad-2d.component';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { xToTemp, tempToX, yToTint, tintToY } from './wb-pad-math';
import { WbPickService } from '../image-canvas/wb-pick.service';
import { EditorStateService } from '../../editor/editor-state.service';
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
  imports: [MuiPad2dComponent, MapleIconComponent],
  templateUrl: './wb-pad.component.html',
  styleUrl: './wb-pad.component.scss',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WbPadComponent {
  private library = inject(LibraryStateService);
  private pick = inject(WbPickService);
  private editor = inject(EditorStateService);

  /** Eyedropper active (sampling mode). */
  readonly eyedropperActive = signal(false);

  /** Mutually-exclusive color/border pair for the eyedropper button's
   * active state (Tailwind port #3071) — folded into one computed string
   * rather than a base class plus a conditional add-on (hover is layered
   * separately since it never coincides with a state change that also
   * touches these same properties while active). */
  protected eyedropBtnClass(active: boolean): string {
    return active
      ? 'bg-[color:var(--pro-accent-28)] border-[color:var(--pro-accent)] text-[color:var(--pro-accent)]'
      : 'bg-transparent border-transparent text-[color:var(--pro-text-muted)] hover:border-[color:var(--pro-border)] hover:bg-white/[0.07] hover:text-[color:var(--pro-text)]';
  }

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

  /**
   * Where the current white balance came from (#2434) — the provenance the
   * sidecar carries, phrased for the panel. A sampled pair names the point
   * it was picked at (as image percentages) and the version of the
   * derivation behind it, so two sidecars that disagree can be told apart.
   */
  readonly provenanceLabel = computed<string>(() => {
    const adj = this.adj();
    if (!adj || adj.wbSource === 'AsShot') return 'As Shot';
    if (adj.wbSource !== 'Sampled') return adj.wbSource;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    return `Sampled at ${pct(adj.wbSampleX)}, ${pct(adj.wbSampleY)} · v${adj.wbAlgorithmVersion}`;
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

  /**
   * Arm the canvas pick overlay and apply the sample the user clicks.
   *
   * Pressing the button while armed cancels — the same press is the way out
   * of pick mode, so the cursor can never be stranded in it.
   */
  async onEyedropperClick(): Promise<void> {
    if (this.eyedropperActive()) {
      this.pick.cancel();
      this.eyedropperActive.set(false);
      return;
    }
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.eyedropperActive.set(true);
    try {
      const point = await this.pick.arm();
      if (!point) return;
      await this.editor.sampleWhiteBalanceAt(id, point.nx, point.ny);
    } finally {
      this.eyedropperActive.set(false);
    }
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
