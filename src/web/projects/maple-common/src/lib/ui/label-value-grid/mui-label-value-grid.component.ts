// MuiLabelValueGrid — the Maple UI design-system Label-Value Grid molecule
// (unified-component-catalog.md §2.5; Built from: Text). A two-column
// metadata grid (e.g. EXIF: Camera / ISO / Aperture rows).

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiLabelValueRow {
  readonly label: string;
  readonly value: string;
}

@Component({
  selector: 'mui-label-value-grid',
  standalone: true,
  imports: [MuiTextComponent],
  templateUrl: './mui-label-value-grid.component.html',
  styleUrl: './mui-label-value-grid.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiLabelValueGridComponent {
  readonly rows = input.required<readonly MuiLabelValueRow[]>();
}
