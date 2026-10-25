import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AuthService, MuiButtonComponent, type DeviceSession } from '@maple-common';

const PLATFORM_LABELS: ReadonlyMap<string, string> = new Map([
  ['tvos', 'Apple TV'],
  ['watchos', 'Apple Watch'],
]);

/** Lists and revokes platform-marked paired-device sessions (Apple TV, Apple Watch). */

@Component({
  selector: 'maple-paired-devices',
  standalone: true,
  imports: [DatePipe, MuiButtonComponent],
  templateUrl: './paired-devices.component.html',
  host: { class: 'set-vars block bg-transparent' },
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

  platformLabel(platform: string): string {
    return PLATFORM_LABELS.get(platform) ?? platform;
  }

  reload(): void {
    this.error.set(null);
    this.auth.listDeviceSessions().subscribe({
      next: (s) => this.sessions.set(s),
      error: () => this.error.set('Could not load paired devices.'),
    });
  }

  async revoke(session: DeviceSession): Promise<void> {
    const ok = confirm(`Sign out "${session.label}"? The device will need to be paired again.`);
    if (!ok) return;
    this.busyId.set(session.id);
    this.error.set(null);
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
