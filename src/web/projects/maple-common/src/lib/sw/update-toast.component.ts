// UpdateToastComponent — the in-app "a new version is ready" prompt.
//
// Rendered once at the root (see RootShellComponent) so both the Hosted and
// Self-Hosted shells show it. Pure view: all state + actions live in
// AppUpdateService. Styling follows the utility-class convention used by the
// other banners (see error-banner) — no component stylesheet needed.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AppUpdateService } from './app-update.service';

@Component({
  selector: 'maple-update-toast',
  standalone: true,
  templateUrl: './update-toast.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UpdateToastComponent {
  private readonly updates = inject(AppUpdateService);

  readonly show = this.updates.showToast;

  install(): void {
    void this.updates.installNow();
  }

  dismiss(): void {
    this.updates.dismiss();
  }
}
