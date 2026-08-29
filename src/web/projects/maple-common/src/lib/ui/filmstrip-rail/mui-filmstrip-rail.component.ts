// MuiFilmstripRail — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Collapsible vertical thumbnails, built from Media Cell, Icon.
// Selection follows `activeId`, same contract as Filmstrip Row.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import { MuiMediaCellComponent } from '../media-cell/mui-media-cell.component';
import type { MuiFilmstripItem } from '../filmstrip-row/mui-filmstrip-row.component';

@Component({
  selector: 'mui-filmstrip-rail',
  standalone: true,
  imports: [MuiIconComponent, MuiMediaCellComponent],
  templateUrl: './mui-filmstrip-rail.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class MuiFilmstripRailComponent {
  readonly items = input.required<readonly MuiFilmstripItem[]>();
  readonly activeId = model<string | null>(null);
  readonly collapsed = model<boolean>(false);

  readonly activated = output<string>();

  toggleCollapsed(): void {
    this.collapsed.update((value) => !value);
  }

  select(id: string): void {
    this.activeId.set(id);
    this.activated.emit(id);
  }
}
