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

import { ChangeDetectionStrategy, Component, OnInit, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import {
  type NetworkConfigPatch,
  type NetworkConfigResponse,
  BunApiBackendService,
  errorMessage,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';

type LoadState = { kind: 'loading' } | { kind: 'loaded' } | { kind: 'error'; message: string };

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

@Component({
  selector: 'maple-network-settings',
  standalone: true,
  imports: [FormsModule, SettingsShellComponent, SettingsIconComponent],
  templateUrl: './network-settings.component.html',
  styleUrl: './network-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NetworkSettingsComponent implements OnInit {
  private readonly api = inject(BunApiBackendService);

  protected readonly config = signal<NetworkConfigResponse | null>(null);
  protected readonly loadState = signal<LoadState>({ kind: 'loading' });
  protected readonly saveState = signal<SaveState>({ kind: 'idle' });

  // ── Editable form ────────────────────────────────────────────────────────
  protected readonly fEnabled = signal(true);
  protected readonly fIpOverride = signal('');
  protected readonly fPortOverride = signal('');
  /** Seed the form from the server config exactly once (first load); a
   * later refresh must not clobber an in-progress edit. */
  private formSeeded = false;

  constructor() {
    effect(() => {
      const cfg = this.config();
      if (!cfg || this.formSeeded) return;
      this.formSeeded = true;
      this.seedForm(cfg);
    });
  }

  ngOnInit(): void {
    void this.load();
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
        this.saveState.set({
          kind: 'error',
          message: 'Port must be an integer between 1 and 65535.',
        });
        return;
      }
      portOverride = parsed;
    }

    const patch: NetworkConfigPatch = {
      enabled: this.fEnabled(),
      local_ip_override: ipOverride.length > 0 ? ipOverride : null,
      local_port_override: portOverride,
    };

    this.saveState.set({ kind: 'saving' });
    try {
      const fresh = await firstValueFrom(this.api.saveNetworkConfig(patch));
      this.config.set(fresh);
      this.formSeeded = false;
      this.seedForm(fresh);
      this.formSeeded = true;
      this.saveState.set({ kind: 'saved' });
      setTimeout(() => {
        this.saveState.update((s) => (s.kind === 'saved' ? { kind: 'idle' } : s));
      }, 2000);
    } catch (err) {
      this.saveState.set({ kind: 'error', message: errorMessage(err) });
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
