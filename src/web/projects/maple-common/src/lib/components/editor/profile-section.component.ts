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
  readonly autoFit = computed(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.lensCorrectionsFor(id).autoFit : undefined;
  });
  readonly description = computed(() =>
    this.profile() === 'Auto'
      ? this.autoFit() === true
        ? 'Color and contrast matched to this image’s embedded camera preview.'
        : this.autoFit() === false
          ? 'Auto matching is unavailable for this image; using Neutral rendering.'
          : 'Checking Auto matching for this image…'
      : 'Uses a fixed base rendering.',
  );

  select(value: string): void {
    const id = this.library.focusedAssetId();
    if (!id || (value !== 'Auto' && value !== 'Neutral') || value === this.profile()) return;
    this.editor.commit('adjustment', `Profile: ${value}`);
    this.library.updateAdjustment(id, { profile: value });
    this.editor.endEdit();
  }
}
