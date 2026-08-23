// MuiCollapsible — the Maple UI design-system Collapsible molecule
// (unified-component-catalog.md §2.5; Built from: Icon, Text). A disclosure
// header + animated content region. Built fresh, tokenized and OnPush,
// rather than reusing the older `lib/collapsible/MapleCollapsibleComponent`
// app component per the wave-3 brief.

import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-collapsible',
  standalone: true,
  imports: [MuiIconComponent, MuiTextComponent],
  templateUrl: './mui-collapsible.component.html',
  styleUrl: './mui-collapsible.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiCollapsibleComponent {
  readonly label = input.required<string>();
  readonly open = model<boolean>(false);

  toggle(): void {
    this.open.update((value) => !value);
  }
}
