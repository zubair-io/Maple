// GpuLiveRenderSettingsComponent — the "Web GPU live render" panel on the
// Workers settings page (#1062). The operator ramp/kill switch for the wgpu +
// WGSL live-render path in the browser editor, backed by
// GET/PUT /api/render/config.
//
// Reads through `RenderConfigService` rather than fetching on its own: that
// service already owns the client's copy of the config (app initializer +
// poll) and is what feeds `GpuLiveRenderGate`, so the panel shows exactly what
// this client believes and a save lands on the same signal the editor reads.
// Expanding the row refreshes first, so an operator opening the panel sees a
// current value rather than one up to a poll interval old.
//
// The toggle saves immediately — a kill switch you have to remember to commit
// is a kill switch that gets left half-thrown.

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  BunApiBackendService,
  GpuLiveRenderGate,
  RenderConfigService,
  errorMessage,
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
export class GpuLiveRenderSettingsComponent {
  private readonly backend = inject(BunApiBackendService);
  private readonly renderConfig = inject(RenderConfigService);
  private readonly gate = inject(GpuLiveRenderGate);

  /** The client's current copy of the config — `null` until the first
   * successful fetch (offline, or signed in moments ago). */
  protected readonly config = this.renderConfig.config;
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** In-flight value while a save is running, so the checkbox tracks the click
   * and snaps back if the save fails. */
  private readonly pending = signal<boolean | null>(null);

  /**
   * What the checkbox shows: the in-flight value, else the fetched config,
   * else the gate's own effective state. The last fallback matters — if the
   * API was unreachable at startup the operator must still be able to throw
   * the switch, not stare at a spinner.
   */
  protected readonly checked = computed(
    () => this.pending() ?? this.config()?.gpu_live_render_enabled ?? this.gate.enabled(),
  );

  /** What THIS browser is actually doing — the saved setting combined with the
   * build-time token. Whether a given browser then reaches the GPU at all
   * still depends on WebGPU being present and its adapter working. */
  protected readonly localGpuEnabled = this.gate.enabled;

  protected readonly expanded = signal(false);

  protected toggleExpanded(): void {
    const next = !this.expanded();
    this.expanded.set(next);
    // Pull a fresh value when the operator opens the row, so what they see is
    // not up to one poll interval stale.
    if (next) void this.renderConfig.refresh();
  }

  /** The collapsed row states what this browser is ACTUALLY doing, not what the
   * operator last saved: a deployment whose build-time token is hard-off runs
   * on the CPU whatever the saved value says, and a "GPU" pill there would be a
   * lie. The saved value is what the checkbox and the provenance readout show. */
  protected statusLabel(): string {
    return this.localGpuEnabled() ? 'GPU' : 'CPU fallback';
  }

  protected statusColor(): string {
    return this.localGpuEnabled() ? 'var(--s-ok)' : 'var(--s-text-dim)';
  }

  /** One-line provenance readout for the collapsed header. */
  protected summaryLine(): string {
    const cfg = this.config();
    if (!cfg) return 'Not loaded';
    return cfg.source.gpu_live_render_enabled === 'db'
      ? 'Set by operator'
      : 'Default (no value saved)';
  }

  /** Flip the switch and persist immediately. The PUT response IS the newly
   * resolved config, so it is adopted directly rather than re-read: that pushes
   * the new value through the gate — this tab's next image open already takes
   * the new path instead of waiting for the poll — and cannot be lost to a
   * poll GET that happened to be in flight across the save. */
  protected async setEnabled(next: boolean): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    this.pending.set(next);
    try {
      const saved = await firstValueFrom(
        this.backend.saveRenderConfig({ gpu_live_render_enabled: next }),
      );
      this.renderConfig.adopt(saved);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.pending.set(null);
      this.saving.set(false);
    }
  }
}
