// Noise reduction section — luminance, color.

import { Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleCollapsibleComponent } from '../../collapsible/maple-collapsible.component';
import { EditorSliderComponent } from './slider.component';

@Component({
  selector: 'editor-noise-section',
  standalone: true,
  imports: [MapleCollapsibleComponent, EditorSliderComponent],
  template: `
    <maple-collapsible label="Noise Reduction" storageKey="dev-noise" [padInner]="false" [defaultOpen]="false">
      @if (assetId()) {
        <editor-slider label="Luminance" [value]="adj().nrLuminance" [min]="0" [max]="100" (change)="patch('nrLuminance', $event)"/>
        <editor-slider label="Color"     [value]="adj().nrColor"     [min]="0" [max]="100" (change)="patch('nrColor', $event)"/>
      }
    </maple-collapsible>
  `,
})
export class NoiseSectionComponent {
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
