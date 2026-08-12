// SignInComponent — shown at `/sign-in` in the Self-Hosted build.
//
// On mount, calls `auth.bootstrap()` to learn whether this server has been
// claimed yet. If not, the form claims it (creating the owner user + first
// passkey). If yes, the form signs an existing user in via WebAuthn.

import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService, errorMessage } from '@maple-common';

/**
 * Post-sign-in destination from the guard's `returnUrl` query param
 * (auth.guard.ts) — internal paths only, so a crafted link can't turn
 * sign-in into an open redirect. `//host` is scheme-relative (external),
 * hence the second check. Exported for unit tests.
 */
export function safeReturnUrl(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

@Component({
  standalone: true,
  selector: 'maple-sign-in',
  imports: [FormsModule, RouterLink],
  templateUrl: './sign-in.component.html',
  styleUrl: './sign-in.component.scss',
})
export class SignInComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  /** Where to land after a successful sign-in (guard-provided, validated). */
  private returnUrl(): string {
    return safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
  }

  email = '';
  claimed = signal<boolean | null>(null);
  devLoginEnabled = signal(false);
  busy = signal(false);
  error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      const r = await this.auth.bootstrap();
      this.claimed.set(r.claimed);
      this.devLoginEnabled.set(r.dev_login_enabled);
    } catch (e: unknown) {
      this.error.set(errorMessage(e));
    }
  }

  // Claims this server (creates the owner + first passkey). Only the claim
  // form submits; passkey sign-in goes through signInPasskey() (#1377).
  async submit(): Promise<void> {
    if (this.claimed() !== false) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.claim(this.email, 'Web');
      // In the Apple shell's WKWebView the native host has already
      // received the tokens via the `maple` message handler and is
      // about to dismiss the sheet. Skip the SPA navigation so we
      // don't waste a round-trip loading the library only to be
      // closed.
      if (!this.auth.isNativeShell) {
        await this.router.navigateByUrl(this.returnUrl());
      }
    } catch (e: unknown) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Usernameless passkey sign-in (#1304) — no email needed. The browser offers
   * the user's discoverable passkeys for this site; the server identifies the
   * account from the chosen credential.
   */
  async signInPasskey(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.signIn();
      if (!this.auth.isNativeShell) {
        await this.router.navigateByUrl(this.returnUrl());
      }
    } catch (e: unknown) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async devSignIn(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.devSignIn();
      if (!this.auth.isNativeShell) {
        await this.router.navigateByUrl(this.returnUrl());
      }
    } catch (e: unknown) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
