import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  BATCH_RENAME_ENABLED,
  DRAG_MOVE_CAPABILITY,
  LibraryStateService,
  TRASH_CAPABILITY,
} from '@maple-common';
import { SelfHostedBrowseController } from '../self-hosted-browse/self-hosted-browse.controller';
import { BrowseActionButtonComponent } from './browse-action-button.component';

@Component({
  selector: 'app-self-hosted-browse-actions',
  standalone: true,
  imports: [BrowseActionButtonComponent],
  templateUrl: './self-hosted-browse-actions.component.html',
  styleUrl: './self-hosted-browse-actions.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelfHostedBrowseActionsComponent {
  protected readonly state = inject(LibraryStateService);
  protected readonly controller = inject(SelfHostedBrowseController);
  private readonly batchRenameEnabled = inject(BATCH_RENAME_ENABLED);
  private readonly dragMove = inject(DRAG_MOVE_CAPABILITY);
  protected readonly trash = inject(TRASH_CAPABILITY);
  protected readonly canEditMetadata = computed(() => this.state.selectedCount() >= 1);
  protected readonly canMergePano = computed(() => this.state.selectedCount() >= 2);
  protected readonly canBatchRename = computed(
    () => this.batchRenameEnabled && this.state.selectedCount() >= 1,
  );
  protected readonly canMoveTo = computed(
    () => this.dragMove.available() && this.state.selectedCount() >= 1,
  );
  protected readonly canTrashSelected = computed(
    () => this.trash.available() && !this.trash.busy() && this.state.selectedCount() >= 1,
  );

  /** Sends the current grid selection to Trash — reversible (the Trash
   * panel restores it), so unlike permanent delete this needs no
   * confirmation, matching the Finder/Explorer convention the design doc
   * calls out for "Delete → Trash → Restore". */
  trashSelected(): void {
    const sourceId = this.state.selectedSourceId();
    if (!sourceId) return;
    this.trash.trashAssets([...this.state.selectedAssetIds()], sourceId);
  }
}
