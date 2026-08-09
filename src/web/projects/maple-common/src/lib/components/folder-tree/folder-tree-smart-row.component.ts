// FolderTreeSmartRowComponent — a top-level smart-collection or album row
// (#2749 review: extracted out of `folder-tree.component.html`'s `@else`
// branch to help clear a fallow-audit-web template-complexity finding on
// that file). Plain presentational component, no service imports beyond
// the pure icon-name lookup it inherited from `FolderTreeComponent`.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MapleIconComponent, MapleIconName } from '../../icons/maple-icon.component';
import { SidebarEntry } from '../../models/folder';

@Component({
  selector: 'app-folder-tree-smart-row',
  standalone: true,
  imports: [MapleIconComponent, DecimalPipe],
  templateUrl: './folder-tree-smart-row.component.html',
  styleUrl: './folder-tree-smart-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeSmartRowComponent {
  readonly entry = input.required<SidebarEntry>();
  readonly selected = input(false);

  readonly activate = output<void>();

  protected readonly icon = computed<MapleIconName>(() => {
    const entry = this.entry();
    if (entry.kind === 'album') return 'tag';
    const map: Record<string, MapleIconName> = {
      photos: 'photos',
      heart: 'heart',
      check: 'check',
      x: 'x',
    };
    return entry.icon && map[entry.icon] ? map[entry.icon] : 'dot';
  });
}
