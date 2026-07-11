// White balance section — temperature, tint + WB preset pills.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ADJUSTMENT_RANGES } from '../../generated/adjustment-model.generated';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleCollapsibleComponent } from '../../collapsible/maple-collapsible.component';
import { EditorSliderComponent } from './slider.component';
import { WbPresetPillsComponent, WbPresetSelection } from './wb-preset-pills.component';

/**
 * The adjustment patch a WB preset selection produces. Named presets carry
 * their own pair; 'As Shot' restores the camera's seeded display pair
 * (`asShot`) — it renders via the sentinel (temperature/tint omitted from
 * the sidecar, #1892), so leaving the previous Custom values visible would
 * show numbers the render no longer uses. A pair component that is neither
 * in the preset nor in the seed stays untouched.
 */
function wbPresetPatch(
  sel: WbPresetSelection,
  asShot: { temperature: number; tint: number } | undefined,
): Record<string, unknown> {
  const temperature = sel.temperature ?? asShot?.temperature;
  const tint = sel.tint ?? asShot?.tint;
  return {
    whiteBalancePreset: sel.preset,
    ...(temperature !== undefined && { temperature }),
    ...(tint !== undefined && { tint }),
  };
}

@Component({
  selector: 'editor-white-balance-section',
  standalone: true,
  imports: [MapleCollapsibleComponent, EditorSliderComponent, WbPresetPillsComponent],
  templateUrl: './white-balance-section.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WhiteBalanceSectionComponent {
  /** ±150 — ACR's crs:Tint span, generated from the raw-core schema (#1870). */
  readonly tintRange = ADJUSTMENT_RANGES.tint;
  private state = inject(LibraryStateService);
  assetId = computed(() => this.state.focusedAssetId());
  adj = computed(() => {
    const id = this.assetId();
    return id ? this.state.adjustmentFor(id)() : null!;
  });

  patch(field: string, value: number): void {
    const id = this.assetId();
    if (id) this.state.updateAdjustment(id, { [field]: value } as never);
  }

  onPreset(sel: WbPresetSelection): void {
    const id = this.assetId();
    if (!id) return;
    const asShot = sel.preset === 'As Shot' ? this.state.asShotWbFor(id) : undefined;
    this.state.updateAdjustment(id, wbPresetPatch(sel, asShot) as never);
  }
}
