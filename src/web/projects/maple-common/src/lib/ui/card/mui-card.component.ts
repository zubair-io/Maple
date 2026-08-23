// MuiCard — Maple UI Molecules-L2 (unified-component-catalog.md §3). Image +
// title + metadata tile, built from Image, Text, Badge.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiImageComponent } from '../image/mui-image.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { handleActivationKeydown } from '../internal/activation-keydown';

@Component({
  selector: 'mui-card',
  standalone: true,
  imports: [MuiBadgeComponent, MuiImageComponent, MuiTextComponent],
  templateUrl: './mui-card.component.html',
  styleUrl: './mui-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiCardComponent {
  readonly src = input.required<string>();
  readonly alt = input.required<string>();
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  readonly badgeLabel = input<string | null>(null);

  readonly pressed = output<void>();

  onClick(): void {
    this.pressed.emit();
  }

  onKeydown(event: KeyboardEvent): void {
    handleActivationKeydown(event, () => this.pressed.emit());
  }
}
