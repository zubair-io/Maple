// mask-panel.component.ts — Mask tool surface (#1541), the web twin of the
// Apple Mask panel (`docs/design/maple-ui/components/mask-panel.md`).
//
// Takes the dock-side panel slot while the Mask tool is armed (the same swap
// the crop toolbar makes): a list of the image's mask layers with add /
// remove / select, and — for the selected layer — its shape controls
// (feather, invert) and the ten local develop controls a layer can carry.
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
import type { LocalAdjustment, LocalMask, PartialAdjustments } from '../../models/local-adjustment';
import { MaskSessionService } from '../mask-overlay/mask-session.service';

/** One of the ten local controls, with the range its global twin uses. */
interface MaskControl {
  id: keyof PartialAdjustments;
  label: string;
  min: number;
  max: number;
  step: number;
}

const MASK_CONTROLS: readonly MaskControl[] = [
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
];

function maskLayerTitle(mask: LocalMask, index: number): string {
  return `${mask.kind === 'linear' ? 'Linear' : 'Radial'} ${index + 1}`;
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
  protected readonly controls = MASK_CONTROLS;

  protected readonly rows = computed(() =>
    this.session.layers().map((layer, index) => ({
      index,
      icon: (layer.mask.kind === 'linear' ? 'tool-dehaze' : 'tool-vignette') as MapleIconName,
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
  protected readonly feather = computed(() => this.selected()?.mask.feather ?? 0.5);

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

  protected onFeatherChange(value: number): void {
    this.session.setFeather(value);
  }

  protected onInvertChange(checked: boolean): void {
    this.session.setInverted(checked);
  }
}
