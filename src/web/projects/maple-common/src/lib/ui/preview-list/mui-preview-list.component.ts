// MuiPreviewList — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Before -> after row list, built from List Row, Text.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MuiListRowComponent } from '../list-row/mui-list-row.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiPreviewItem {
  readonly id: string;
  readonly before: string;
  readonly after: string;
}

@Component({
  selector: 'mui-preview-list',
  standalone: true,
  imports: [MuiListRowComponent, MuiTextComponent],
  templateUrl: './mui-preview-list.component.html',
  styleUrl: './mui-preview-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPreviewListComponent {
  readonly items = input.required<readonly MuiPreviewItem[]>();

  readonly pressed = output<string>();
}
