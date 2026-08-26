// Profile section — Auto / Neutral toggle (Auto Profile Phase 1, ticket #567).
//
// Mounted as the first section in the develop tab so the render-shaping
// profile is the first decision the user makes about an image.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { MuiCollapsibleComponent } from '../../ui/collapsible/mui-collapsible.component';
import type { Profile } from '../../generated/adjustment-model.generated';

@Component({
  selector: 'editor-profile-section',
  standalone: true,
  imports: [MuiCollapsibleComponent],
  templateUrl: './profile-section.component.html',
  styleUrl: './profile-section.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileSectionComponent {
  private state = inject(LibraryStateService);
  assetId = computed(() => this.state.focusedAssetId());
  adj = computed(() => {
    const id = this.assetId();
    return id ? this.state.adjustmentFor(id)() : null!;
  });

  setProfile(profile: Profile): void {
    const id = this.assetId();
    if (id) this.state.updateAdjustment(id, { profile });
  }
}
