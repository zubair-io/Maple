import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AuthService, type DeviceSession } from '@maple-common';

/**
 * Paired devices (Apple TVs) — lists platform-marked device sessions and
 * revokes them. Milestone B of the Maple TV epic; the sessions are minted by
 * the iOS app during TV pairing (milestone C).
 */
@Component({
  selector: 'maple-paired-devices',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './paired-devices.component.html',
  styleUrl: './paired-devices.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PairedDevicesComponent {
  private readonly auth = inject(AuthService);

  readonly sessions = signal<DeviceSession[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);

  constructor() {
    this.reload();
  }

  reload(): void {
    this.auth.listDeviceSessions().subscribe({
      next: (s) => this.sessions.set(s),
      error: () => this.error.set('Could not load paired devices.'),
    });
  }

  async revoke(session: DeviceSession): Promise<void> {
    const ok = confirm(`Sign out "${session.label}"? The device will need to be paired again.`);
    if (!ok) return;
    this.busyId.set(session.id);
    try {
      await this.auth.revokeDeviceSession(session.id);
      this.sessions.set((this.sessions() ?? []).filter((s) => s.id !== session.id));
    } catch {
      this.error.set('Revoke failed — try again.');
    } finally {
      this.busyId.set(null);
    }
  }
}
