// MuiList — the Maple UI design-system List atom
// (docs/design/maple-ui/components/list.md). Renders ordered or unordered
// items with a chosen marker style and spacing density; items may nest one
// or more levels, rendered with the catalog's "nesting indent" via a
// recursive template.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';

export interface MuiListItem {
  readonly text: string;
  readonly children?: readonly MuiListItem[];
}

export type MuiListMarker = 'disc' | 'dash' | 'none';
export type MuiListDensity = 'compact' | 'comfortable';

@Component({
  selector: 'mui-list',
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: './mui-list.component.html',
  styleUrl: './mui-list.component.scss',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiListComponent {
  readonly items = input.required<readonly MuiListItem[]>();
  readonly ordered = input<boolean>(false);
  readonly marker = input<MuiListMarker>('disc');
  readonly density = input<MuiListDensity>('comfortable');
}
