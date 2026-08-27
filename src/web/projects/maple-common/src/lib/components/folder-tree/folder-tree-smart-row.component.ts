// FolderTreeSmartRowComponent — a top-level smart-collection or album row
// (#2749 review: extracted out of `folder-tree.component.html`'s `@else`
// branch to help clear a fallow-audit-web template-complexity finding on
// that file). Plain presentational component, no service imports beyond
// the pure icon-name lookup it inherited from `FolderTreeComponent`.

import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { formatNumber } from '@angular/common';
import type { MapleIconName } from '../../icons/maple-icon.component';
import { SidebarEntry } from '../../models/folder';
import { MuiTreeRowComponent } from '../../ui/tree-row/mui-tree-row.component';

@Component({
  selector: 'app-folder-tree-smart-row',
  standalone: true,
  imports: [MuiTreeRowComponent],
  templateUrl: './folder-tree-smart-row.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeSmartRowComponent {
  private readonly locale = inject(LOCALE_ID);

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

  /** Pre-formatted (thousands-separated) so migrating this row's plain
   * `.tree-row` markup onto `mui-tree-row` doesn't lose the `DecimalPipe`
   * formatting the original template applied inline (MW4, ticket #3031). */
  protected readonly formattedCount = computed<string | null>(() => {
    const count = this.entry().count;
    return count == null ? null : formatNumber(count, this.locale);
  });
}
