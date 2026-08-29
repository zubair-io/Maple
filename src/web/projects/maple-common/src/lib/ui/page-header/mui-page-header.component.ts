// MuiPageHeader — the Maple UI design-system Page Header molecule
// (unified-component-catalog.md §2.5; Built from: Button, Text, Icon). A
// title bar with an optional leading back action, a centered truncating
// title, an `[actions]`-projected trailing action slot, and an optional
// overflow ("more") action.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-page-header',
  standalone: true,
  imports: [MuiButtonComponent, MuiTextComponent],
  templateUrl: './mui-page-header.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageHeaderComponent {
  readonly title = input.required<string>();
  readonly showBack = input<boolean>(true);
  readonly showMore = input<boolean>(false);

  readonly back = output<void>();
  readonly more = output<void>();
}
