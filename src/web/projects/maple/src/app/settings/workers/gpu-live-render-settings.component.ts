// GpuLiveRenderSettingsComponent — the "Web GPU live render" panel on the
// Workers settings page (#1062). The operator ramp/kill switch for the wgpu +
// WGSL live-render path in the browser editor, backed by
// GET/PUT /api/render/config.
//
// Modeled on DerivativeAuditSettingsComponent: a collapsible settings row with
// a status pill and an immediate-effect toggle (no Save button — a kill switch
// you have to remember to commit is a kill switch that gets left half-thrown).
//
// Saving also refreshes RenderConfigService, so the operator's own tab moves to
// the new path on its next image open rather than waiting for the poll.

import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  BunApiBackendService,
  GpuLiveRenderGate,
  RenderConfigService,
  errorMessage,
  type RenderConfigResponse,
} from '@maple-common';
import { SettingsRowComponent } from '../settings-row.component';
import { SettingsIconComponent } from '../settings-icon.component';

@Component({
  selector: 'maple-gpu-live-render-settings',
  standalone: true,
  imports: [SettingsRowComponent, SettingsIconComponent],
  templateUrl: './gpu-live-render-settings.component.html',
  styleUrl: './gpu-live-render-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GpuLiveRenderSettingsComponent implements OnInit {
  private readonly backend = inject(BunApiBackendService);
  private readonly renderConfig = inject(RenderConfigService);
  private readonly gate = inject(GpuLiveRenderGate);

  protected readonly config = signal<RenderConfigResponse | null>(null);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Collapsed by default, matching the other rows on this page. */
  protected readonly expanded = signal(false);
  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  /** What THIS browser is actually doing — the saved setting combined with the
   * build-time token. Lets the operator confirm the flip took without opening
   * an image. Whether a given browser then reaches the GPU at all still depends
   * on WebGPU being present and its adapter working. */
  protected readonly localGpuEnabled = this.gate.enabled;

  protected statusLabel(): string {
    const cfg = this.config();
    if (!cfg) return '…';
    return cfg.gpu_live_render_enabled ? 'GPU' : 'CPU fallback';
  }

  protected statusColor(): string {
    const cfg = this.config();
    if (!cfg) return 'var(--s-text-dim)';
    return cfg.gpu_live_render_enabled ? 'var(--s-ok)' : 'var(--s-text-dim)';
  }

  /** One-line provenance readout for the collapsed header. */
  protected summaryLine(): string {
    const cfg = this.config();
    if (!cfg) return '';
    return cfg.source.gpu_live_render_enabled === 'db'
      ? 'Set by operator'
      : 'Default (no value saved)';
  }

  async ngOnInit(): Promise<void> {
    try {
      this.config.set(await firstValueFrom(this.backend.getRenderConfig()));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Flip the switch and persist immediately, reverting the optimistic UI on
   * failure so the panel never claims a save that did not happen. */
  protected async setEnabled(next: boolean): Promise<void> {
    const prev = this.config();
    if (!prev || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    this.config.set({
      gpu_live_render_enabled: next,
      source: { gpu_live_render_enabled: 'db' },
    });
    try {
      const saved = await firstValueFrom(
        this.backend.saveRenderConfig({ gpu_live_render_enabled: next }),
      );
      this.config.set(saved);
      // Pull the fresh value through the gate so this tab stops waiting on the
      // poll — its next image open already takes the new path.
      await this.renderConfig.refresh();
    } catch (e) {
      this.config.set(prev);
      this.error.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }
}
