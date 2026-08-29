// TrashStatusBannerComponent — the Trash panel's mutation toast + load-
// error banner (#2749 review: split out of `trash-list.component.ts`,
// itself already an extraction from `trash-panel.component.html`, to get
// that file's CRAP score under fallow-audit-web's threshold — a 31-line
// template with 6 conditional constructs was still just over it). Plain
// presentational component, no service imports.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

@Component({
  selector: 'app-trash-status-banner',
  standalone: true,
  templateUrl: './trash-status-banner.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrashStatusBannerComponent {
  readonly toast = input<string | null>(null);
  readonly loadError = input<string | null>(null);

  readonly dismissToast = output<void>();
}
