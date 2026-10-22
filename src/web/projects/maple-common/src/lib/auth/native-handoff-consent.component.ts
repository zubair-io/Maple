// NativeHandoffConsentComponent — explicit user consent interstitial before
// handing a one-time PKCE sign-in code to a native Maple app (#4673).
//
// When a native app opens the browser with `?native_callback=maple-app&
// code_challenge=…&state=…` and the browser already holds a live session
// cookie, we must NOT auto-mint and redirect a code on page load (which would
// allow a one-click account takeover via a crafted link). Instead, this modal
// displays the signed-in account, requesting platform, and device label, and
// issues the code only when the user explicitly clicks "Approve sign-in".

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MuiButtonComponent } from '../ui/button/mui-button.component';
import { MuiTextComponent } from '../ui/text/mui-text.component';
import { AuthService } from './auth.service';

@Component({
  selector: 'maple-native-handoff-consent',
  standalone: true,
  imports: [MuiButtonComponent, MuiTextComponent],
  templateUrl: './native-handoff-consent.component.html',
  styleUrl: './native-handoff-consent.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NativeHandoffConsentComponent {
  private readonly auth = inject(AuthService);

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly handoff = computed(() => this.auth.pendingNativeHandoff());
  protected readonly user = computed(() => this.auth.user());
  protected readonly visible = computed(() => this.user() !== null && this.handoff() !== null);

  protected readonly userLabel = computed(() => {
    const u = this.user();
    if (!u) return '';
    return u.email ? `${u.email} (${u.role})` : `${u.role === 'owner' ? 'Owner' : 'Member'}`;
  });

  protected async approve(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const ok = await this.auth.resumeNativeHandoff();
      if (!ok) {
        this.error.set('Could not issue a sign-in code. Please try again.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected cancel(): void {
    if (this.busy()) return;
    this.error.set(null);
    this.auth.dismissNativeHandoff();
  }
}
