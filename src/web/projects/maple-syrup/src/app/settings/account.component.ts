// AccountComponent — `/settings/account` (Hosted).
//
// Minimal real Hosted settings surface: the signed-in identity plus a
// sign-out action, backed by the same shared `AuthService` (`@maple-common`)
// both apps already bootstrap via `provideAuthBootstrap()` +
// `authInterceptor` (see `app.config.ts`). Self Hosted's Account page
// (`projects/maple/src/app/settings/account/`) additionally manages
// WebAuthn passkey devices and a worker-config preference — those ride on
// Self-Hosted-only concepts (device pairing, invite-based membership) that
// don't apply to Hosted, and `SettingsShellComponent` there is a Self
// Hosted app component (not exported from `maple-common`), so it isn't
// importable here. This page is intentionally self-contained rather than a
// stub: it renders the real signed-in state or a real signed-out state.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '@maple-common';

@Component({
  selector: 'app-account',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './account.component.html',
  styleUrl: './account.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly user = this.auth.user;
  protected readonly isOwner = computed(() => this.auth.user()?.role === 'owner');

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigate(['/']);
  }
}
