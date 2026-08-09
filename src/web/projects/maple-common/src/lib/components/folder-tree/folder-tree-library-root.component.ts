// FolderTreeLibraryRootComponent — one registered-library root entry: its
// `FolderTreeNodeComponent` row (+ recursion) plus the Trash pseudo-node
// row that follows every library root (#2749 review: extracted out of
// `folder-tree.component.html` to help clear a fallow-audit-web
// template-complexity finding on that file — the Trash row's own `@if`
// was one of the remaining contributors once the recursive node markup
// had already moved out). Owns `TRASH_CAPABILITY` directly instead of
// threading `libraryIdForTrashRow`/`trashBadgeFor` down from
// `FolderTreeComponent` as inputs.

import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { SidebarEntry } from '../../models/folder';
import { FolderTreeNodeComponent, type FolderCrudRequestEvent } from './folder-tree-node.component';
import { TRASH_CAPABILITY } from '../../trash/trash-capability';
import { libraryIdForRootNode, trashCountLabel } from '../../trash/trash-node';
import { TrashNodeRowComponent } from '../../trash/trash-node-row.component';

@Component({
  selector: 'app-folder-tree-library-root',
  standalone: true,
  imports: [FolderTreeNodeComponent, TrashNodeRowComponent],
  templateUrl: './folder-tree-library-root.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeLibraryRootComponent {
  private readonly state = inject(LibraryStateService);
  private readonly trash = inject(TRASH_CAPABILITY);

  readonly section = input.required<SidebarEntry>();

  readonly crudRequested = output<FolderCrudRequestEvent>();

  /** `null` on Hosted, and for anything that isn't a real library root —
   * see `trash-node.ts`'s module doc. */
  libraryIdForTrashRow(): string | null {
    if (!this.trash.available()) return null;
    return libraryIdForRootNode(this.section().id, this.state.registeredFolders());
  }

  trashBadgeFor(libraryId: string): string | null {
    return trashCountLabel(this.trash.countByLibrary()[libraryId]);
  }

  onTrashNodeActivate(libraryId: string, libraryLabel: string): void {
    this.trash.open(libraryId, libraryLabel);
  }
}
