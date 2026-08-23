// MuiEmptyState — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.3). Icon, title, message, optional action — built from Icon, Text,
// Button.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-empty-state',
  standalone: true,
  imports: [MuiButtonComponent, MuiIconComponent, MuiTextComponent],
  templateUrl: './mui-empty-state.component.html',
  styleUrl: './mui-empty-state.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiEmptyStateComponent {
  readonly icon = input.required<MapleIconName>();
  readonly title = input.required<string>();
  readonly message = input<string | null>(null);
  readonly actionLabel = input<string | null>(null);

  readonly actionPressed = output<void>();
}
