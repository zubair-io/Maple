// Left sidebar — collapsible sections, nested folder tree, smart items, albums.
// Ported from _design-reference/lib/tree.jsx MapleFileTree / FolderNode / TreeSection.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NgTemplateOutlet, DecimalPipe } from '@angular/common';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleIconComponent, MapleIconName } from '../../icons/maple-icon.component';
import { SidebarEntry } from '../../models/folder';

@Component({
  selector: 'app-folder-tree',
  standalone: true,
  imports: [MapleIconComponent, NgTemplateOutlet, DecimalPipe],
  styleUrl: './folder-tree.component.scss',
  templateUrl: './folder-tree.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeComponent {
  state = inject(LibraryStateService);

  isFolderOpen(node: SidebarEntry): boolean {
    const map = this.state.folderOpen();
    return map[node.id] !== undefined ? map[node.id] : node.open === true;
  }

  onFolderClick(node: SidebarEntry, e: MouseEvent): void {
    e.stopPropagation();
    if (node.absPath) {
      // FS-walk path — load this directory's contents into the grid AND
      // attach its subdirs as tree children in one shot. `openSelfHostedSubfolder`
      // handles both via `_attachFsChildren`, so we don't separately call
      // `expandFsFolder` here — that would fire a duplicate `/api/fs/dir`
      // request for the same path because the first call's response hasn't
      // landed yet (childrenStatus is still undefined at click time).
      this.state.openSelfHostedSubfolder(node.absPath, node.id);
      this.state.setFolderOpen(node.id, true);
      return;
    }
    this.state.selectedSourceId.set(node.id);
  }

  onChevronClick(node: SidebarEntry, e: MouseEvent): void {
    e.stopPropagation();
    const willOpen = !this.isFolderOpen(node);
    this.state.setFolderOpen(node.id, willOpen);
    if (willOpen && node.absPath && node.childrenStatus === undefined) {
      this.state.expandFsFolder(node);
    }
    if (willOpen && node.absPath && node.childrenStatus === 'error') {
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
