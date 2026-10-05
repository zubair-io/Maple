// NetworkSettingsComponent — `/settings/network` (owner-gated).
//
// Lets an operator override the LAN address self-hosted clients prefer over
// the public URL when they're on the same network as the server. Auto-
// detection (via os.networkInterfaces() on the server) is only a
// convenience default: the primary supported deployment
// (docker compose --profile app) runs the server in a container with
// default bridge networking, so auto-detect often reports the container's
// internal bridge IP rather than the host's real LAN IP — the operator
// override exists specifically to correct that.
//
// All network/persistence goes through BunApiBackendService directly (two
// calls — GET/PUT /api/network/config — doesn't warrant a dedicated
// service, unlike Observability's heavier IndexedDB-cached SDK wiring).

import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  type ApnsConfigResponse,
  type NetworkConfigPatch,
  type NetworkConfigResponse,
  BunApiBackendService,
  errorMessage,
  MuiButtonComponent,
  MuiCheckboxComponent,
  MuiInputComponent,
} from '@maple-common';
import { ManagedHttpsComponent } from './managed-https.component';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';
import { seedSettingsForm, SettingsSaveStatus } from '../settings-form';

type LoadState = { kind: 'loading' } | { kind: 'loaded' } | { kind: 'error'; message: string };

@Component({
  selector: 'maple-network-settings',
  standalone: true,
  imports: [
    SettingsShellComponent,
    ManagedHttpsComponent,
    SettingsIconComponent,
    MuiButtonComponent,
    MuiCheckboxComponent,
    MuiInputComponent,
  ],
  templateUrl: './network-settings.component.html',
  host: { class: 'set-vars set-page-host' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NetworkSettingsComponent implements OnInit {
  private readonly api = inject(BunApiBackendService);

  protected readonly config = signal<NetworkConfigResponse | null>(null);
  protected readonly loadState = signal<LoadState>({ kind: 'loading' });
  private readonly networkSave = new SettingsSaveStatus();
  protected readonly saveState = this.networkSave.state;

  // ── APNs push-to-signal (#1025) — separate load/save from the LAN
  // address form above: different API resource, different save action. ──
  protected readonly apnsConfig = signal<ApnsConfigResponse | null>(null);
  protected readonly apnsLoadState = signal<LoadState>({ kind: 'loading' });
  private readonly apnsSave = new SettingsSaveStatus();
  protected readonly apnsSaveState = this.apnsSave.state;
  protected readonly fApnsEnabled = signal(false);

  // ── Editable form ────────────────────────────────────────────────────────
  protected readonly fEnabled = signal(true);
  protected readonly fIpOverride = signal('');
  protected readonly fPortOverride = signal('');
  protected readonly fPublicOrigin = signal('');
  private readonly applyNetworkForm = seedSettingsForm(this.config, (cfg) => this.seedForm(cfg));
  private readonly applyApnsForm = seedSettingsForm(this.apnsConfig, (cfg) =>
    this.fApnsEnabled.set(cfg.enabled),
  );

  ngOnInit(): void {
    void this.load();
    void this.loadApns();
  }

  private async load(): Promise<void> {
    this.loadState.set({ kind: 'loading' });
    try {
      const cfg = await firstValueFrom(this.api.getNetworkConfig());
      this.config.set(cfg);
      this.loadState.set({ kind: 'loaded' });
    } catch (err) {
      this.loadState.set({ kind: 'error', message: errorMessage(err) });
    }
  }

  private seedForm(cfg: NetworkConfigResponse): void {
    this.fPublicOrigin.set(cfg.public_origin ?? '');
    this.fEnabled.set(cfg.enabled);
    // Only pre-fill the override field when one is actually saved — an
    // auto-detected value shown in "Current (resolved)" below must not
    // masquerade as a saved override the operator would re-save verbatim.
    this.fIpOverride.set(cfg.source.local_ip === 'db_override' ? (cfg.local_ip ?? '') : '');
    this.fPortOverride.set(cfg.source.local_port === 'db_override' ? String(cfg.local_port) : '');
  }

  protected async save(): Promise<void> {
    const ipOverride = this.fIpOverride().trim();
    const portRaw = this.fPortOverride().trim();

    let portOverride: number | null | undefined;
    if (portRaw.length === 0) {
      portOverride = null;
    } else {
      const parsed = Number(portRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        this.networkSave.fail('Port must be an integer between 1 and 65535.');
        return;
      }
      portOverride = parsed;
    }

    const patch: NetworkConfigPatch = {
      public_origin: this.fPublicOrigin().trim() || null,
      enabled: this.fEnabled(),
      local_ip_override: ipOverride.length > 0 ? ipOverride : null,
      local_port_override: portOverride,
    };

    this.networkSave.start();
    try {
      const fresh = await firstValueFrom(this.api.saveNetworkConfig(patch));
      this.config.set(fresh);
      this.applyNetworkForm(fresh);
      this.networkSave.succeed();
    } catch (err) {
      this.networkSave.fail(errorMessage(err));
    }
  }

  private async loadApns(): Promise<void> {
    this.apnsLoadState.set({ kind: 'loading' });
    try {
      const cfg = await firstValueFrom(this.api.getApnsConfig());
      this.apnsConfig.set(cfg);
      this.apnsLoadState.set({ kind: 'loaded' });
    } catch (err) {
      this.apnsLoadState.set({ kind: 'error', message: errorMessage(err) });
    }
  }

  /** Bound to the checkbox's `(checkedChange)`. Flips the signal
   * optimistically (so the UI feels instant) but remembers the pre-toggle
   * value so `saveApns` can revert it on a failed PUT (Copilot review
   * #3214) — without this, a rejected save left the checkbox showing
   * "on" while nothing was actually persisted. */
  protected onApnsToggle(checked: boolean): void {
    const previous = this.fApnsEnabled();
    this.fApnsEnabled.set(checked);
    void this.saveApns(previous);
  }

  protected async saveApns(revertTo?: boolean): Promise<void> {
    this.apnsSave.start();
    try {
      const fresh = await firstValueFrom(this.api.saveApnsConfig({ enabled: this.fApnsEnabled() }));
      this.apnsConfig.set(fresh);
      // Reflect back whatever the server actually persisted (Copilot
      // review #3214) — today that's always exactly what we sent, but a
      // future server-side normalization/validation must not leave the
      // checkbox silently drifted from the real saved value until a
      // full reload.
      this.applyApnsForm(fresh);
      this.apnsSave.succeed();
    } catch (err) {
      if (revertTo !== undefined) this.fApnsEnabled.set(revertTo);
      this.apnsSave.fail(errorMessage(err));
    }
  }

  protected sourceLabel(kind: string): string {
    switch (kind) {
      case 'db_override':
        return 'operator override';
      case 'auto_detected':
        return 'auto-detected';
      case 'unavailable':
        return 'unavailable';
      case 'default':
        return 'default';
      default:
        return kind;
    }
  }
}
