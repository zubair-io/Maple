// MuiInfoPanel — Maple UI Organisms (unified-component-catalog.md §4.3).
// Full asset metadata, built from Label-Value Grid, Histogram, Keyword Row,
// Rating & Flags, Inline Rename Field. Data states: `loading` gates the
// whole body behind a centered Spinner. `metadata` is required, so the
// caller always supplies at least an empty array — Label-Value Grid already
// renders that gracefully as nothing, so there's no separate
// metadata-empty state to build here.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiHistogramComponent } from '../histogram/mui-histogram.component';
import { MuiInlineRenameFieldComponent } from '../inline-rename-field/mui-inline-rename-field.component';
import { MuiKeywordRowComponent } from '../keyword-row/mui-keyword-row.component';
import { MuiLabelValueGridComponent } from '../label-value-grid/mui-label-value-grid.component';
import type { MuiLabelValueRow } from '../label-value-grid/mui-label-value-grid.component';
import { MuiRatingFlagsComponent } from '../rating-flags/mui-rating-flags.component';
import type { MuiRatingFlagState } from '../rating-flags/mui-rating-flags.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';

export interface MuiInfoPanelHistogram {
  readonly r: readonly number[];
  readonly g: readonly number[];
  readonly b: readonly number[];
}

@Component({
  selector: 'mui-info-panel',
  standalone: true,
  imports: [
    MuiHistogramComponent,
    MuiInlineRenameFieldComponent,
    MuiKeywordRowComponent,
    MuiLabelValueGridComponent,
    MuiRatingFlagsComponent,
    MuiSpinnerComponent,
  ],
  templateUrl: './mui-info-panel.component.html',
  styleUrl: './mui-info-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiInfoPanelComponent {
  readonly loading = input<boolean>(false);
  readonly filename = model<string>('');
  readonly metadata = input.required<readonly MuiLabelValueRow[]>();
  readonly histogram = input<MuiInfoPanelHistogram | null>(null);
  readonly keywords = input.required<readonly MuiChip[]>();
  readonly rating = model<number>(0);
  readonly flag = model<MuiRatingFlagState>('none');

  readonly renamed = output<string>();
  readonly keywordAdded = output<string>();
  readonly keywordRemoved = output<string>();
}
