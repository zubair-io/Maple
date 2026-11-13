// TrashStatusBannerComponent — the Trash panel's mutation toast (a Maple UI
// `mui-toast` that stays until dismissed, its variant set per outcome) + load-
// error banner (#2749 review: split out of `trash-list.component.ts`,
// itself already an extraction from `trash-panel.component.html`, to get
// that file's CRAP score under fallow-audit-web's threshold — a 31-line
// template with 6 conditional constructs was still just over it). Plain
// presentational component, no service imports.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MuiToastComponent, type MuiToastVariant } from '../ui/toast/mui-toast.component';

@Component({
  selector: 'app-trash-status-banner',
  standalone: true,
  imports: [MuiToastComponent],
  templateUrl: './trash-status-banner.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrashStatusBannerComponent {
  readonly toast = input<string | null>(null);
  readonly toastVariant = input<MuiToastVariant>('info');
  readonly loadError = input<string | null>(null);

  readonly dismissToast = output<void>();
}
