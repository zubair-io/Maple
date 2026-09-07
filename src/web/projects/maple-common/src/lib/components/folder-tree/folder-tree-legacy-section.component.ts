// FolderTreeLegacySectionComponent — the "Folders" section-header fallback
// (#2749 review: extracted out of `folder-tree.component.html` to help
// clear a fallow-audit-web template-complexity finding on that file). Only
// renders anything if a stale `'section'`-kind entry slips through
// `LibraryStateService.sidebarTree()` — the live state puts libraries at
// the top level directly — so this is legacy-compat plumbing, isolated
// into its own tiny component rather than inline branching in the main
// tree template.

import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { SidebarEntry } from '../../models/folder';
import { FolderTreeNodeComponent, type FolderCrudRequestEvent } from './folder-tree-node.component';
import { deriveFolderRows } from './folder-tree-row';

@Component({
  selector: 'app-folder-tree-legacy-section',
  standalone: true,
  imports: [MapleIconComponent, FolderTreeNodeComponent],
  templateUrl: './folder-tree-legacy-section.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeLegacySectionComponent {
  protected readonly state = inject(LibraryStateService);

  readonly section = input.required<SidebarEntry>();

  readonly crudRequested = output<FolderCrudRequestEvent>();

  /** The section's folder rows with `open` / `selected` derived once here
   * (#2847, see `folder-tree-row.ts`). */
  protected readonly childRows = computed(() =>
    deriveFolderRows(
      this.section().children,
      this.state.folderOpen(),
      this.state.selectedSourceId(),
    ),
  );

  toggle(): void {
    this.state.toggleSection(this.section().id);
  }
}
