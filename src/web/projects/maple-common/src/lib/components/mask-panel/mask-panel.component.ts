// mask-panel.component.ts — Mask tool surface (#1541), the web twin of the
// Apple Mask panel (`docs/design/maple-ui/components/mask-panel.md`).
//
// Takes the dock-side panel slot while the Mask tool is armed (the same swap
// the crop toolbar makes): a list of the image's mask layers with add /
// remove / select, and — for the selected layer — its shape controls
// (feather, invert), the sixteen local develop controls a layer can carry —
// the ten tone/colour sliders, then the six spatial ones Lightroom's own
// local panel groups below them (#3407: Texture … Defringe) — and the
// colour-range refinement (#362: enable toggle, canvas eyedropper, five
// coordinate sliders).
// Composed from the Maple UI primitives (`mui-list-row`, `mui-button`,
// `mui-living-slider`, `mui-checkbox`, `mui-text`). The canvas half —
// handles + weight tint — is `MaskOverlayComponent`.
//
// Continuous edits (sliders) ride `MaskSessionService`'s gesture — one undo
// entry per drag, opened on `dragStart` and closed on `dragEnd`; discrete
// ones (add / remove / invert / reset) commit their own.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';
import { MuiCheckboxComponent } from '../../ui/checkbox/mui-checkbox.component';
import { MuiListRowComponent } from '../../ui/list-row/mui-list-row.component';
import { MuiLivingSliderComponent } from '../../ui/living-slider/mui-living-slider.component';
import { MuiTextComponent } from '../../ui/text/mui-text.component';
import type { MapleIconName } from '../../icons/maple-icon.component';
import {
  isGeometricMask,
  type LocalAdjustment,
  type LocalMask,
  type PartialAdjustments,
} from '../../models/local-adjustment';
import { MaskSessionService } from '../mask-overlay/mask-session.service';
import { RANGE_CONTROLS, displayHue, type RangeControl } from '../mask-overlay/mask-range';
import { CanvasPickService, RANGE_PICK_PROMPT } from '../image-canvas/canvas-pick.service';

/** One of the sixteen local controls, with the range its global twin uses.
 *  `bipolar` is derived, never authored: a slider draws a centre notch
 *  exactly when its range mirrors zero, which is false for the two
 *  one-sided spatial controls (Noise, Defringe — both 0 … 100). */
interface MaskControl {
  id: keyof PartialAdjustments;
  label: string;
  min: number;
  max: number;
  step: number;
  bipolar: boolean;
}

const CONTROL_RANGES: ReadonlyArray<Omit<MaskControl, 'bipolar'>> = [
  { id: 'exposure', label: 'Exposure', min: -4, max: 4, step: 0.05 },
  { id: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1 },
  { id: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1 },
  { id: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1 },
  { id: 'whites', label: 'Whites', min: -100, max: 100, step: 1 },
  { id: 'blacks', label: 'Blacks', min: -100, max: 100, step: 1 },
  { id: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1 },
  { id: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1 },
  // Local temperature is a Kelvin DELTA off the frame's white point
  // (raw-core `local_adjustments::apply_pixel`), not the absolute CCT the
  // global slider carries.
  { id: 'temperature', label: 'Temp', min: -2000, max: 2000, step: 10 },
  { id: 'tint', label: 'Tint', min: -150, max: 150, step: 1 },
  // The six SPATIAL controls (#3407), in Lightroom's own panel order. They
  // run as one neighbourhood pass over the layer's output rather than per
  // pixel, but the panel plumbing is identical to the ten above — same
  // slider, same gesture, one undo entry per drag.
  { id: 'texture', label: 'Texture', min: -100, max: 100, step: 1 },
  { id: 'clarity', label: 'Clarity', min: -100, max: 100, step: 1 },
  { id: 'dehaze', label: 'Dehaze', min: -100, max: 100, step: 1 },
  { id: 'sharpness', label: 'Sharpness', min: -100, max: 100, step: 1 },
  { id: 'luminanceNoise', label: 'Noise', min: 0, max: 100, step: 1 },
  { id: 'defringe', label: 'Defringe', min: 0, max: 100, step: 1 },
];

const MASK_CONTROLS: readonly MaskControl[] = CONTROL_RANGES.map((control) => ({
  ...control,
  bipolar: control.min === -control.max,
}));

const MASK_KIND_LABEL: Readonly<Record<LocalMask['kind'], string>> = {
  linear: 'Linear',
  radial: 'Radial',
  bitmap: 'Person',
  everywhere: 'Everywhere',
};

const MASK_KIND_ICON: Readonly<Record<LocalMask['kind'], MapleIconName>> = {
  linear: 'tool-dehaze',
  radial: 'tool-vignette',
  bitmap: 'person-circle',
  everywhere: 'photos',
};

function maskLayerTitle(mask: LocalMask, index: number): string {
  return `${MASK_KIND_LABEL[mask.kind]} ${index + 1}`;
}

function maskLayerSubtitle(layer: LocalAdjustment): string | null {
  const edited = MASK_CONTROLS.filter((c) => layer.adjustments[c.id] !== undefined).length;
  const parts = [
    layer.mask.kind === 'radial' && layer.mask.invert ? 'inverted' : null,
    edited === 0 ? null : `${edited} edited`,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

@Component({
  selector: 'editor-mask-panel',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiCheckboxComponent,
    MuiListRowComponent,
    MuiLivingSliderComponent,
    MuiTextComponent,
  ],
  templateUrl: './mask-panel.component.html',
  styleUrl: './mask-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MaskPanelComponent {
  protected readonly session = inject(MaskSessionService);
  private readonly pick = inject(CanvasPickService);
  protected readonly controls = MASK_CONTROLS;
  protected readonly rangeControls = RANGE_CONTROLS;

  protected readonly rows = computed(() =>
    this.session.layers().map((layer, index) => ({
      index,
      icon: MASK_KIND_ICON[layer.mask.kind],
      title: maskLayerTitle(layer.mask, index),
      subtitle: maskLayerSubtitle(layer),
      active: this.session.selectedIndex() === index,
    })),
  );

  protected readonly selected = this.session.selected;
  protected readonly isRadial = computed(() => this.selected()?.mask.kind === 'radial');
  protected readonly inverted = computed(() => {
    const mask = this.selected()?.mask;
    return mask?.kind === 'radial' ? mask.invert : false;
  });
  /** The selected layer's feather, or null for a bitmap/everywhere mask
   *  (no parametric edge to feather — the slider is hidden, #3300). */
  protected readonly feather = computed<number | null>(() => {
    const mask = this.selected()?.mask;
    return mask && isGeometricMask(mask) ? mask.feather : null;
  });

  protected valueOf(control: MaskControl): number {
    return this.session.adjustment(control.id);
  }

  protected onValueChange(control: MaskControl, value: number): void {
    this.session.setAdjustment(control.id, value);
  }

  protected onDragStart(): void {
    this.session.beginGesture();
  }

  protected onDragEnd(): void {
    this.session.endGesture();
  }

  /** Double-click / keyboard reset on one slider: back to "not set". */
  protected onControlReset(control: MaskControl): void {
    this.session.updateSelected(true, (layer) => {
      const { [control.id]: _dropped, ...rest } = layer.adjustments;
      return { ...layer, adjustments: rest };
    });
  }

  // ── Colour range (#362) ──────────────────────────────────────────────────

  /** The band centre, as people read a hue wheel. */
  protected readonly rangeHue = computed(() => {
    const range = this.session.range();
    return range ? Math.round(displayHue(range.hueDeg)) : 0;
  });

  protected rangeValueOf(control: RangeControl): number {
    return this.session.rangeValue(control.id);
  }

  protected onRangeEnabledChange(checked: boolean): void {
    this.session.setRangeEnabled(checked);
  }

  protected onRangeValueChange(control: RangeControl, value: number): void {
    this.session.setRangeField(control.id, value);
  }

  /**
   * Arm the canvas pick overlay and seed the range from the clicked colour.
   * Pressing while armed cancels — the same press is the way out of pick
   * mode, so the cursor can never be stranded in it (#3309's rule for the
   * white-balance eyedropper).
   */
  protected async onEyedropper(): Promise<void> {
    if (this.pick.active()) {
      this.pick.cancel();
      return;
    }
    if (this.session.rangeSampleInFlight()) return;
    const point = await this.pick.arm(RANGE_PICK_PROMPT);
    if (!point) return;
    await this.session.sampleRangeAt(point.nx, point.ny);
  }

  protected onFeatherChange(value: number): void {
    this.session.setFeather(value);
  }

  protected onInvertChange(checked: boolean): void {
    this.session.setInverted(checked);
  }
}
