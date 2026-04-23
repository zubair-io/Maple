// Sharpening section — amount, radius, detail, masking.

import { Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleCollapsibleComponent } from '../../collapsible/maple-collapsible.component';
import { EditorSliderComponent } from './slider.component';

@Component({
  selector: 'editor-sharpening-section',
  standalone: true,
  imports: [MapleCollapsibleComponent, EditorSliderComponent],
  template: `
    <maple-collapsible label="Sharpening" storageKey="dev-sharpen" [padInner]="false" [defaultOpen]="false">
      @if (assetId()) {
        <editor-slider label="Amount"   [value]="adj().sharpenAmount"   [min]="0"   [max]="150"              (change)="patch('sharpenAmount', $event)"/>
        <editor-slider label="Radius"   [value]="adj().sharpenRadius"   [min]="0.5" [max]="3.0"  [step]="0.1" (change)="patch('sharpenRadius', $event)"/>
        <editor-slider label="Detail"   [value]="adj().sharpenDetail"   [min]="0"   [max]="100"              (change)="patch('sharpenDetail', $event)"/>
        <editor-slider label="Masking"  [value]="adj().sharpenMasking"  [min]="0"   [max]="100"              (change)="patch('sharpenMasking', $event)"/>
      }
    </maple-collapsible>
  `,
})
export class SharpeningSectionComponent {
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
}
