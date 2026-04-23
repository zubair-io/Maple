// Tone section — exposure, contrast, highlights, shadows, whites, blacks.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleCollapsibleComponent } from '../../collapsible/maple-collapsible.component';
import { EditorSliderComponent } from './slider.component';

@Component({
  selector: 'editor-tone-section',
  standalone: true,
  imports: [MapleCollapsibleComponent, EditorSliderComponent],
  template: `
    <maple-collapsible label="Tone" storageKey="dev-tone" [padInner]="false">
      @if (assetId()) {
        <editor-slider
          label="Exposure"
          [value]="adj().exposure"
          [min]="-4"
          [max]="4"
          [step]="0.01"
          (change)="patch('exposure', $event)"
        />
        <editor-slider
          label="Contrast"
          [value]="adj().contrast"
          [min]="-100"
          [max]="100"
          (change)="patch('contrast', $event)"
        />
        <editor-slider
          label="Highlights"
          [value]="adj().highlights"
          [min]="-100"
          [max]="100"
          (change)="patch('highlights', $event)"
        />
        <editor-slider
          label="Shadows"
          [value]="adj().shadows"
          [min]="-100"
          [max]="100"
          (change)="patch('shadows', $event)"
        />
        <editor-slider
          label="Whites"
          [value]="adj().whites"
          [min]="-100"
          [max]="100"
          (change)="patch('whites', $event)"
        />
        <editor-slider
          label="Blacks"
          [value]="adj().blacks"
          [min]="-100"
          [max]="100"
          (change)="patch('blacks', $event)"
        />
      }
    </maple-collapsible>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToneSectionComponent {
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
}
