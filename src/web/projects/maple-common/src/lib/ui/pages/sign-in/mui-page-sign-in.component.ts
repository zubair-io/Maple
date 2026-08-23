// MuiPageSignIn — Maple UI Pages (unified-component-catalog.md §6). App
// Shell with a centered sign-in form built from Form Field, Button, and
// Banner in Content.
//
// Cross-organism wiring: submitting reads both Form Fields' current values
// and drives the Banner — empty fields produce an error Banner naming what's
// missing, a filled form produces a success Banner naming the signed-in
// email. Dismissing the Banner clears it.

import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { MuiAppShellComponent } from '../../app-shell/mui-app-shell.component';
import { MuiFormFieldComponent } from '../../form-field/mui-form-field.component';
import { MuiButtonComponent } from '../../button/mui-button.component';
import { MuiBannerComponent } from '../../banner/mui-banner.component';
import type { MuiBannerVariant } from '../../banner/mui-banner.component';

interface SignInBanner {
  readonly message: string;
  readonly variant: MuiBannerVariant;
}

@Component({
  selector: 'mui-page-sign-in',
  standalone: true,
  imports: [MuiAppShellComponent, MuiFormFieldComponent, MuiButtonComponent, MuiBannerComponent],
  templateUrl: './mui-page-sign-in.component.html',
  styleUrl: './mui-page-sign-in.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageSignInComponent {
  readonly email = signal<string>('');
  readonly password = signal<string>('');
  readonly banner = signal<SignInBanner | null>(null);

  onSubmit(): void {
    const email = this.email().trim();
    const password = this.password().trim();
    if (email.length === 0 || password.length === 0) {
      this.banner.set({ message: 'Enter your email and password.', variant: 'error' });
      return;
    }
    this.banner.set({ message: `Signed in as ${email}.`, variant: 'success' });
  }

  dismissBanner(): void {
    this.banner.set(null);
  }
}
