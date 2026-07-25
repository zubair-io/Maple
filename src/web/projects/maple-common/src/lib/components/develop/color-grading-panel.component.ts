// ColorGradingPanelComponent — the Color Grading surface (#275).
//
// Four round wheels (Shadows / Midtones / Highlights / Global), each with
// a luminance slider under it, plus the balance slider that shifts the
// zone crossovers. This is the ONLY colour-toning surface in the editor:
// it supersedes the old Split Tone pill exactly as Lightroom's Color
// Grading panel superseded Split Toning, and the shadow/highlight
// hue+saturation pairs are still the `splitTone*` fields that ACR writes
// to `crs:SplitToning*`.
//
// Writes go straight to `LibraryStateService.updateAdjustment`, the same
// single write path the WB pad uses for its two-field puck.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { ADJUSTMENT_RANGES, type AdjustmentModel } from '../../models/adjustment-model';
import { ColorWheelComponent } from './color-wheel.component';
import { LivingSliderComponent } from './living-slider.component';
import type { WheelValue } from './color-wheel-math';

/** One wheel's three model fields. */
interface ZoneFields {
  readonly hue: keyof AdjustmentModel & string;
  readonly saturation: keyof AdjustmentModel & string;
  readonly luminance: keyof AdjustmentModel & string;
}

/** A zone row: label plus the fields its wheel and slider drive. */
export interface GradeZone extends ZoneFields {
  readonly id: 'shadows' | 'midtones' | 'highlights' | 'global';
  readonly label: string;
}

/**
 * The four zones in tonal order, global last. Shadow and highlight
 * hue/saturation live on the `splitTone*` fields — ACR's own layout.
 */
export const GRADE_ZONES: readonly GradeZone[] = [
  {
    id: 'shadows',
    label: 'Shadows',
    hue: 'splitToneShadowHue',
    saturation: 'splitToneShadowSaturation',
    luminance: 'colorGradeShadowLuminance',
  },
  {
    id: 'midtones',
    label: 'Midtones',
    hue: 'colorGradeMidtoneHue',
    saturation: 'colorGradeMidtoneSaturation',
    luminance: 'colorGradeMidtoneLuminance',
  },
  {
    id: 'highlights',
    label: 'Highlights',
    hue: 'splitToneHighlightHue',
    saturation: 'splitToneHighlightSaturation',
    luminance: 'colorGradeHighlightLuminance',
  },
  {
    id: 'global',
    label: 'Global',
    hue: 'colorGradeGlobalHue',
    saturation: 'colorGradeGlobalSaturation',
    luminance: 'colorGradeGlobalLuminance',
  },
];

const LUM_RANGE = ADJUSTMENT_RANGES.colorGradeMidtoneLuminance;
const BALANCE_RANGE = ADJUSTMENT_RANGES.splitToneBalance;

@Component({
  selector: 'pro-color-grading-panel',
  standalone: true,
  imports: [ColorWheelComponent, LivingSliderComponent],
  templateUrl: './color-grading-panel.component.html',
  styleUrl: './color-grading-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ColorGradingPanelComponent {
  private readonly library = inject(LibraryStateService);

  readonly zones = GRADE_ZONES;
  readonly lumMin = LUM_RANGE[0];
  readonly lumMax = LUM_RANGE[1];
  readonly balanceMin = BALANCE_RANGE[0];
  readonly balanceMax = BALANCE_RANGE[1];

  private readonly adj = computed<AdjustmentModel | null>(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)() : null;
  });

  readonly balance = computed<number>(() => this.adj()?.splitToneBalance ?? 0);

  /** Read one numeric field off the focused asset's adjustment model. */
  valueOf(field: keyof AdjustmentModel & string): number {
    const v = this.adj()?.[field];
    return typeof v === 'number' ? v : 0;
  }

  onWheelChange(zone: GradeZone, value: WheelValue): void {
    this.patch({ [zone.hue]: value.hue, [zone.saturation]: value.saturation });
  }

  onLuminanceChange(zone: GradeZone, value: number): void {
    this.patch({ [zone.luminance]: value });
  }

  onLuminanceReset(zone: GradeZone): void {
    this.patch({ [zone.luminance]: 0 });
  }

  onBalanceChange(value: number): void {
    this.patch({ splitToneBalance: value });
  }

  onBalanceReset(): void {
    this.patch({ splitToneBalance: 0 });
  }

  private patch(fields: Partial<AdjustmentModel>): void {
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.library.updateAdjustment(id, fields);
  }
}
