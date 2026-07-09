// White balance section — temperature, tint + WB preset pills.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ADJUSTMENT_RANGES } from '../../generated/adjustment-model.generated';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleCollapsibleComponent } from '../../collapsible/maple-collapsible.component';
import { EditorSliderComponent } from './slider.component';
import { WbPresetPillsComponent, WbPresetSelection } from './wb-preset-pills.component';

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
    const patch: Record<string, unknown> = { whiteBalancePreset: sel.preset };
    if (sel.temperature !== null) patch['temperature'] = sel.temperature;
    if (sel.tint !== null) patch['tint'] = sel.tint;
    this.state.updateAdjustment(id, patch as never);
  }
}
