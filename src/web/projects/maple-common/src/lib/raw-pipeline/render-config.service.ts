// RenderConfigService — pulls the DB-backed render config from the API and
// feeds it into `GpuLiveRenderGate` (#1062).
//
// Lifecycle, mirroring the observability-config "read cache then refresh"
// pattern:
//   1. The gate has ALREADY warm-started from its localStorage cache by the
//      time this runs — that read is synchronous and happens in the gate's
//      field initializer, so a browser that has seen "off" is off before any
//      render can start, network or no network.
//   2. `init()` fires a refresh and returns immediately. Bootstrap is never
//      blocked on the API.
//   3. A poll every `REFRESH_INTERVAL_MS` keeps a long-lived tab honest, so an
//      operator flip reaches already-open clients without anyone reloading.
//      The gate is read per render request, so the flip takes effect on the
//      next decode or live-session open.
//
// A failed refresh is deliberately silent apart from `lastError`: the last
// known value keeps applying, which for a kill switch means "stay off once
// told to go off" rather than springing back on the moment the API blips.

import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { BunApiBackendService } from '../api/bun-api-backend.service';
import { errorMessage } from '../util/errors';
import { GpuLiveRenderGate } from './gpu-live-render.gate';
import type { RenderConfigResponse } from './render-config.model';

/** Poll cadence. One small JSON GET a minute is negligible next to the
 * thumbnail and asset traffic an open library already generates, and it bounds
 * how long a user can stay on a broken GPU path after the operator flips the
 * switch. */
export const RENDER_CONFIG_REFRESH_INTERVAL_MS = 60_000;

@Injectable({ providedIn: 'root' })
export class RenderConfigService implements OnDestroy {
  private readonly api = inject(BunApiBackendService);
  private readonly gate = inject(GpuLiveRenderGate);

  /** Last config the API returned, or `null` before the first success. */
  readonly config = signal<RenderConfigResponse | null>(null);
  /** Last refresh failure. Informational — the gate keeps its prior value. */
  readonly lastError = signal<string | null>(null);

  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** Guards against overlapping refreshes when one request runs long. */
  private inFlight = false;
  /**
   * Bumped by every write. A refresh captures it before its GET and drops the
   * response if it changed meanwhile: the poll can easily have read the config
   * a moment BEFORE a save landed, and applying that stale read afterwards
   * would silently flip the switch back under the operator.
   */
  private writeGeneration = 0;

  /**
   * App-initializer entry point. Returns synchronously — the refresh is
   * fire-and-forget. Idempotent.
   */
  init(): void {
    if (this.started) return;
    this.started = true;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), RENDER_CONFIG_REFRESH_INTERVAL_MS);
  }

  /**
   * Pull the current config and apply it to the gate. Safe to call directly —
   * the settings page uses it to push its own save through immediately instead
   * of waiting for the next poll tick.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const generation = this.writeGeneration;
    try {
      const cfg = await firstValueFrom(this.api.getRenderConfig());
      if (generation !== this.writeGeneration) return; // superseded by a save
      this.config.set(cfg);
      this.lastError.set(null);
      this.gate.apply(cfg.gpu_live_render_enabled);
    } catch (err) {
      // Signed out, offline, or a server blip. The gate keeps whatever it had.
      if (generation !== this.writeGeneration) return;
      this.lastError.set(errorMessage(err));
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Adopt the config a `PUT /api/render/config` just returned, as the settings
   * page does after a save. Preferred over a follow-up `refresh()`: the write
   * response IS the newly resolved config, so re-reading it costs a round trip
   * and — because `refresh()` no-ops while the poll's GET is in flight — can
   * silently leave this client on the value it had before the save.
   */
  adopt(cfg: RenderConfigResponse): void {
    this.writeGeneration += 1;
    this.config.set(cfg);
    this.lastError.set(null);
    this.gate.apply(cfg.gpu_live_render_enabled);
  }

  ngOnDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
