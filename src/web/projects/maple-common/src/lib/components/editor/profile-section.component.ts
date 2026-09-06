import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { MuiSegmentedToggleComponent } from '../../ui/segmented-toggle/mui-segmented-toggle.component';
import type { AdjustmentModel } from '../../models/adjustment-model';

@Component({
  selector: 'editor-profile-section',
  standalone: true,
  imports: [MuiSegmentedToggleComponent],
  templateUrl: './profile-section.component.html',
  styleUrl: './profile-section.component.scss',
  host: { class: 'mb-3 block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileSectionComponent {
  private readonly library = inject(LibraryStateService);
  private readonly editor = inject(EditorStateService);

  readonly options = [
    { value: 'Auto', label: 'Auto' },
    { value: 'Neutral', label: 'Neutral' },
  ];
  readonly adjustment = computed(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)() : null;
  });
  readonly profile = computed<AdjustmentModel['profile']>(
    () => this.adjustment()?.profile ?? 'Auto',
  );
  readonly description = computed(() =>
    this.profile() === 'Auto'
      ? "Fits color and contrast to the camera's embedded preview. Uses Neutral when no preview is available."
      : 'Uses the fixed AgX view transform without matching the embedded preview.',
  );

  select(value: string): void {
    const id = this.library.focusedAssetId();
    if (!id || (value !== 'Auto' && value !== 'Neutral') || value === this.profile()) return;
    this.editor.commit('adjustment', `Profile: ${value}`);
    this.library.updateAdjustment(id, { profile: value });
    this.editor.endEdit();
  }
}
