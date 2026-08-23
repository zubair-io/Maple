// MuiTypingIndicator — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Someone-is-typing affordance, built from Avatar, Text.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MuiAvatarComponent } from '../avatar/mui-avatar.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-typing-indicator',
  standalone: true,
  imports: [MuiAvatarComponent, MuiTextComponent],
  templateUrl: './mui-typing-indicator.component.html',
  styleUrl: './mui-typing-indicator.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'status', 'aria-live': 'polite' },
})
export class MuiTypingIndicatorComponent {
  readonly name = input.required<string>();
}
