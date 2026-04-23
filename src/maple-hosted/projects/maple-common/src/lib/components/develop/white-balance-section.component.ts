// White balance section — temperature, tint + WB preset pills.

import { Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleCollapsibleComponent } from '../../collapsible/maple-collapsible.component';
import { EditorSliderComponent } from './slider.component';
import { WbPresetPillsComponent, WbPresetSelection } from './wb-preset-pills.component';

@Component({
  selector: 'editor-white-balance-section',
  standalone: true,
  imports: [MapleCollapsibleComponent, EditorSliderComponent, WbPresetPillsComponent],
  template: `
    <maple-collapsible label="White Balance" storageKey="dev-wb" [padInner]="false">
      @if (assetId()) {
        <editor-wb-presets
          [active]="adj().whiteBalancePreset"
          (selected)="onPreset($event)"/>
        <editor-slider label="Temperature" [value]="adj().temperature" [min]="2000" [max]="12000" [step]="50"  (change)="patch('temperature', $event)"/>
        <editor-slider label="Tint"        [value]="adj().tint"        [min]="-100" [max]="100"               (change)="patch('tint', $event)"/>
      }
    </maple-collapsible>
  `,
})
export class WhiteBalanceSectionComponent {
  private state = inject(LibraryStateService);
  assetId = computed(() => this.state.focusedAssetId());
  adj     = computed(() => {
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
    if (sel.tint !== null)        patch['tint'] = sel.tint;
    this.state.updateAdjustment(id, patch as never);
  }
}
