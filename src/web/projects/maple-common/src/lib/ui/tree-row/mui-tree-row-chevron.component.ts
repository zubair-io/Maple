// MuiTreeRowChevron — the expand/collapse corner of `mui-tree-row`: chevron
// button, busy spinner, or error-retry glyph. Extracted out of
// `mui-tree-row.component.html` (MW4, ticket #3031 fallow finding) for the
// exact reason `folder-tree-expand-icon.component.ts` (deleted by this same
// migration) documented before it: a three-way busy/error/chevron `@if` /
// `@else-if` / `@else` nested inside an outer expandable/not-expandable
// `@if` is the single biggest cognitive-complexity contributor a tree row's
// template can have. Internal to mui-tree-row — not exported via
// `public-api.ts`.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';

@Component({
  selector: 'mui-tree-row-chevron',
  standalone: true,
  imports: [MuiIconComponent, MuiSpinnerComponent],
  templateUrl: './mui-tree-row-chevron.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiTreeRowChevronComponent {
  readonly expandable = input<boolean>(false);
  readonly expanded = input<boolean>(false);
  readonly busy = input<boolean>(false);
  readonly error = input<boolean>(false);
  readonly errorTitle = input<string | undefined>(undefined);

  readonly toggle = output<Event>();
}
