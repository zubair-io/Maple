// LanSwitchBannerComponent — offers "switch to a local connection" when the
// self-hosted server reports a reachable LAN address.
//
// Rendered once at the root (see RootShellComponent) so both the Hosted and
// Self-Hosted shells could mount it; it renders nothing on Hosted (no
// server, no LAN concept — see LIBRARY_BACKEND gate below). Styling follows
// the utility-class convention used by the other toasts (see
// update-toast.component.html) — no component stylesheet needed.
//
// Explicit opt-in by design: switching means a full-page reload to a
// different origin (http://<lan-ip>:<port> instead of the https:// domain),
// which drops the padlock and changes the address bar. That's a visible
// enough change that it shouldn't happen silently — the user clicks
// "Switch".

import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { LanSwitchCandidate, LanSwitchService } from './lan-switch.service';

type Phase = 'hidden' | 'offering' | 'switching';

@Component({
  selector: 'maple-lan-switch-banner',
  standalone: true,
  templateUrl: './lan-switch-banner.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LanSwitchBannerComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly libraryBackend = inject(LIBRARY_BACKEND);
  private readonly lanSwitch = inject(LanSwitchService);

  private candidate: LanSwitchCandidate | null = null;
  protected readonly phase = signal<Phase>('hidden');

  ngOnInit(): void {
    // No server, no LAN concept, on the Hosted (browser-only) build.
    if (this.libraryBackend !== 'self-hosted') return;
    // Only relevant once signed in — provideAuthBootstrap() has already
    // resolved by the time this component mounts, so `isSignedIn` reflects
    // the real cold-start state.
    if (!this.auth.isSignedIn) return;
    void this.check();
  }

  private async check(): Promise<void> {
    const candidate = await this.lanSwitch.checkAvailable();
    if (!candidate) return;
    this.candidate = candidate;
    this.phase.set('offering');
  }

  protected async switchNow(): Promise<void> {
    if (!this.candidate) return;
    this.phase.set('switching');
    const ok = await this.lanSwitch.switchTo(this.candidate);
    // On success the page is about to navigate away; on failure (code
    // issuance failed — network blip, or the session expired between
    // offering and clicking) quietly drop the offer rather than leaving a
    // stuck "Switching…" button.
    if (!ok) this.phase.set('hidden');
  }

  protected dismiss(): void {
    this.phase.set('hidden');
  }
}
