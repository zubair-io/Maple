// Presence section — vibrance, saturation, clarity, texture, dehaze.

import { Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleCollapsibleComponent } from '../../collapsible/maple-collapsible.component';
import { EditorSliderComponent } from './slider.component';

@Component({
  selector: 'editor-presence-section',
  standalone: true,
  imports: [MapleCollapsibleComponent, EditorSliderComponent],
  template: `
    <maple-collapsible label="Presence" storageKey="dev-presence" [padInner]="false">
      @if (assetId()) {
        <editor-slider label="Vibrance"   [value]="adj().vibrance"   [min]="-100" [max]="100" (change)="patch('vibrance', $event)"/>
        <editor-slider label="Saturation" [value]="adj().saturation" [min]="-100" [max]="100" (change)="patch('saturation', $event)"/>
        <editor-slider label="Clarity"    [value]="adj().clarity"    [min]="-100" [max]="100" (change)="patch('clarity', $event)"/>
        <editor-slider label="Texture"    [value]="adj().texture"    [min]="-100" [max]="100" (change)="patch('texture', $event)"/>
        <editor-slider label="Dehaze"     [value]="adj().dehaze"     [min]="-100" [max]="100" (change)="patch('dehaze', $event)"/>
      }
    </maple-collapsible>
  `,
})
export class PresenceSectionComponent {
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
