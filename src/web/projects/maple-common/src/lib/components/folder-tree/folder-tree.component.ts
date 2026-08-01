// Left sidebar — collapsible sections, nested folder tree, smart items, albums.
// Ported from _design-reference/lib/tree.jsx MapleFileTree / FolderNode / TreeSection.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DecimalPipe, NgComponentOutlet, NgTemplateOutlet } from '@angular/common';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleIconComponent, MapleIconName } from '../../icons/maple-icon.component';
import { SidebarEntry } from '../../models/folder';
import { selectSidebarEntry } from '../../shells/browse-shell/source-selection';
import { FOLDER_TREE_EXTENSION } from './folder-tree-extension';

@Component({
  selector: 'app-folder-tree',
  standalone: true,
  imports: [MapleIconComponent, NgComponentOutlet, NgTemplateOutlet, DecimalPipe],
  styleUrl: './folder-tree.component.scss',
  templateUrl: './folder-tree.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeComponent {
  state = inject(LibraryStateService);
  protected readonly extension = inject(FOLDER_TREE_EXTENSION);

  isFolderOpen(node: SidebarEntry): boolean {
    const map = this.state.folderOpen();
    return map[node.id] !== undefined ? map[node.id] : node.open === true;
  }

  onFolderClick(node: SidebarEntry, e: MouseEvent): void {
    e.stopPropagation();
    // FS-walk / M2-addressed folders load this directory's contents into the
    // grid AND attach its subdirs as tree children in one shot; smart/album/
    // legacy roots are a plain id select. The shared `selectSidebarEntry`
    // helper mirrors this branch so the phone source-picker drawer (which
    // only has the id, not the node) shares the same selection path (#2280).
    selectSidebarEntry(this.state, node.id);
  }

  onChevronClick(node: SidebarEntry, e: MouseEvent): void {
    e.stopPropagation();
    const willOpen = !this.isFolderOpen(node);
    this.state.setFolderOpen(node.id, willOpen);
    const canExpand = node.absPath || node.id.includes(':');
    if (willOpen && canExpand && node.childrenStatus === undefined) {
      this.state.expandFsFolder(node);
    }
    if (willOpen && canExpand && node.childrenStatus === 'error') {
      // Retry on click when previous load failed.
      this.state.expandFsFolder(node);
    }
  }

  iconForSmartOrAlbum(entry: SidebarEntry): MapleIconName {
    if (entry.kind === 'album') return 'tag';
    const map: Record<string, MapleIconName> = {
      photos: 'photos',
      heart: 'heart',
      check: 'check',
      x: 'x',
    };
    return entry.icon && map[entry.icon] ? map[entry.icon] : 'dot';
  }
}
