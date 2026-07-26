// GpuLiveRenderGate — the effective on/off state of the web GPU live-render
// path (#1062, epic #925), combining the build-time token with the DB-backed
// operator setting.
//
// Precedence, most restrictive wins:
//
//   1. `GPU_LIVE_RENDER_ENABLED` (build-time token, default `true`). A
//      deployment that provides `false` is hard-off — the DB setting can never
//      switch on what the build switched off. This mirrors Apple's
//      `MAPLE_GPU_LIVE=0` escape hatch: a last-resort override always wins.
//   2. The operator setting from `GET /api/render/config`, applied through
//      `apply()` by `RenderConfigService`. `false` kills the GPU path.
//   3. Never-seen (fresh browser, API unreachable, signed out) → GPU on, i.e.
//      byte-for-byte today's behaviour.
//
// Deliberately dependency-free apart from the token: this class is read on the
// render path by `RawPipelineService`, so it must not drag HttpClient (or any
// async wiring) into that injector. Fetching lives in `RenderConfigService`,
// which pushes values in via `apply()`.
//
// The last applied value is cached in localStorage and read back
// SYNCHRONOUSLY in the field initializer. That is the property that makes this
// usable as a kill switch: once a browser has seen "off", it starts up off on
// every subsequent load with no network round-trip, even if the API is down.

import { Injectable, computed, inject, signal } from '@angular/core';

import { GPU_LIVE_RENDER_ENABLED } from './gpu-live-render.token';
import { STORAGE_KEYS, TypedStorage } from '../util/typed-storage';

@Injectable({ providedIn: 'root' })
export class GpuLiveRenderGate {
  /** Build/deploy-time switch. `false` here is unconditional. */
  private readonly buildEnabled = inject(GPU_LIVE_RENDER_ENABLED);

  /** Operator setting: `null` until this browser has ever seen one. */
  private readonly operatorEnabled = signal<boolean | null>(
    TypedStorage.get<boolean>(STORAGE_KEYS.GPU_LIVE_RENDER_ENABLED),
  );

  /**
   * Effective state, read per render request so a mid-session flip lands on
   * the next decode / live-session open rather than needing a reload.
   */
  readonly enabled = computed(() => this.buildEnabled && (this.operatorEnabled() ?? true));

  /** True once an operator value (fresh or cached) is in play — the settings
   * page and diagnostics use this to distinguish "on by default" from
   * "explicitly ramped on". */
  readonly hasOperatorValue = computed(() => this.operatorEnabled() !== null);

  /**
   * Apply an operator value fetched from the API and cache it for the next
   * cold start. Idempotent: re-applying the same value writes nothing new and
   * leaves the signal identity alone.
   */
  apply(enabled: boolean): void {
    if (this.operatorEnabled() === enabled) return;
    this.operatorEnabled.set(enabled);
    TypedStorage.set(STORAGE_KEYS.GPU_LIVE_RENDER_ENABLED, enabled);
  }
}
