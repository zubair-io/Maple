// MuiFilmstripRow — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Horizontal scrolling thumbnails, built from Media Cell. Selection
// follows `activeId`.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiMediaCellComponent } from '../media-cell/mui-media-cell.component';

export interface MuiFilmstripItem {
  readonly id: string;
  readonly src: string;
  readonly alt: string;
}

@Component({
  selector: 'mui-filmstrip-row',
  standalone: true,
  imports: [MuiMediaCellComponent],
  templateUrl: './mui-filmstrip-row.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class MuiFilmstripRowComponent {
  readonly items = input.required<readonly MuiFilmstripItem[]>();
  readonly activeId = model<string | null>(null);

  readonly activated = output<string>();

  select(id: string): void {
    this.activeId.set(id);
    this.activated.emit(id);
  }
}
