// GpuFallbackNoticeService — tracks whether the editor's live GPU render
// path (`WebLiveSession`, epic #925 / #1038) is unavailable, and why, so the
// UI can surface it instead of only logging to the console (#2415).
//
// `ImageCanvasGpuPresent` reports into this service (via `GpuPresentHost`)
// rather than owning UI state itself — same separation as the other
// singleton services it already reaches through the host (pipeline, state,
// canvasSvc). Two reasons are distinguished:
//   - 'insecure-context': the ORIGIN itself is insecure
//     (`window.isSecureContext === false` — e.g. a LAN `http://<ip>:port`
//     page), so the browser withholds `navigator.gpu` on principle. The one
//     case serving this connection over HTTPS fixes — the case #2415 exists
//     for — and the only reason allowed to carry the HTTPS message.
//   - 'session-open-failed': everything else — a secure origin whose browser
//     simply doesn't implement WebGPU, a gpu-off WASM bundle, a decode
//     error, a broken present. Not fixable by switching schemes, so the
//     notice doesn't point at HTTPS for this one.
//
// Session-scoped dismissal only (a signal, no storage) — matches the
// LAN-switch banner / update toast: "dismiss" hides it until the next full
// reload, no persistence machinery.

import { Injectable, computed, signal } from '@angular/core';

export type GpuFallbackReason = 'insecure-context' | 'session-open-failed';

@Injectable({ providedIn: 'root' })
export class GpuFallbackNoticeService {
  private readonly reason = signal<GpuFallbackReason | null>(null);
  private readonly dismissed = signal(false);

  readonly visible = computed(() => this.reason() !== null && !this.dismissed());

  readonly message = computed(() => {
    switch (this.reason()) {
      case 'insecure-context':
        return (
          'Editing runs on a reduced-performance path — serve this connection ' +
          'over HTTPS to enable GPU rendering.'
        );
      case 'session-open-failed':
        return (
          'Editing runs on a reduced-performance path — GPU rendering is ' +
          'unavailable in this browser.'
        );
      case null:
        return '';
    }
  });

  /**
   * Records why the GPU live-render path fell back to 2D. The FIRST
   * reported reason wins for the page session: once the origin is known
   * insecure, later per-asset open attempts (which will keep failing for
   * the identical reason) don't need to re-report or flip the message.
   */
  report(reason: GpuFallbackReason): void {
    if (this.reason() === null) this.reason.set(reason);
  }

  /** Clears any recorded fallback — called on a successful GPU session
   * open, so a stale notice from an earlier failed asset doesn't linger
   * once the live GPU path is actually working. */
  clear(): void {
    this.reason.set(null);
  }

  dismiss(): void {
    this.dismissed.set(true);
  }
}
