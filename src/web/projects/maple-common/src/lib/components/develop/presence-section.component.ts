// Presence section — vibrance, saturation, clarity, texture, dehaze.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleCollapsibleComponent } from '../../collapsible/maple-collapsible.component';
import { EditorSliderComponent } from './slider.component';

@Component({
  selector: 'editor-presence-section',
  standalone: true,
  imports: [MapleCollapsibleComponent, EditorSliderComponent],
  templateUrl: './presence-section.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PresenceSectionComponent {
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
