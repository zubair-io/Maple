// MuiSearchBar — Maple UI Molecules-L1 (unified-component-catalog.md §2.1).
// Query pill with clear, built from Icon + Input + Button — the leading
// icon and clear affordance come from Input's `search` variant, and an
// optional trailing ghost Button covers a filters/action trigger.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiInputComponent } from '../input/mui-input.component';
import type { MapleIconName } from '../icon/mui-icon.component';

@Component({
  selector: 'mui-search-bar',
  standalone: true,
  imports: [MuiButtonComponent, MuiInputComponent],
  templateUrl: './mui-search-bar.component.html',
  styleUrl: './mui-search-bar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSearchBarComponent {
  readonly value = model<string>('');
  readonly placeholder = input<string>('Search');
  readonly disabled = input<boolean>(false);
  readonly actionLabel = input<string | null>(null);
  readonly actionIcon = input<MapleIconName | null>(null);

  readonly committed = output<string>();
  readonly actionPressed = output<void>();
}
