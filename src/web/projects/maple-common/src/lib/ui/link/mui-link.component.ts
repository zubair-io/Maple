// MuiLink — the Maple UI design-system Link atom
// (docs/design/maple-ui/components/link.md). A plain inline hyperlink;
// internal navigation renders as a normal anchor, external targets get a
// visible affordance (trailing icon) plus the safe `target="_blank"` +
// `rel="noopener noreferrer"` pair.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';

@Component({
  selector: 'mui-link',
  standalone: true,
  imports: [MuiIconComponent],
  templateUrl: './mui-link.component.html',
  styleUrl: './mui-link.component.scss',
  host: { class: 'inline' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiLinkComponent {
  readonly href = input.required<string>();
  readonly external = input<boolean>(false);
  readonly disabled = input<boolean>(false);
}
