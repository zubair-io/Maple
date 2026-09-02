// CanvasColorSpacePref — the web half of the #1338 sRGB / Display P3 canvas
// toggle (#3191). Mirrors Apple's `CanvasColorSpace` (MapleCore) shape and
// resolution order, but is a per-viewer DISPLAY preference stored purely in
// `localStorage` — not a DB-backed operator setting (unlike
// `GpuLiveRenderGate`, which combines a build-time token with a fetched
// server config). CLAUDE.md's "configure via DB-backed settings" rule is
// about app/runtime configuration an operator manages; this is closer to a
// theme choice — which screen the browser is attached to is not something a
// server-side setting could express, and every other viewer of the same
// asset must be free to pick differently.
//
// Resolution order, matching `CanvasColorSpace.current` (Swift):
//   1. The stored choice, once the user has touched the Settings picker.
//   2. Default: `'display-p3'` when this browser's screen reports the P3
//      gamut (`matchMedia('(color-gamut: p3)')` — the standard CSS Media
//      Queries Level 4 feature every P3-aware engine implements), else
//      `'srgb'`.
//
// Consumed by `RawPipelineService.openLiveSession`, which reads `current()`
// at request time (same pattern as `GpuLiveRenderGate.enabled`) and threads
// it into `WebLiveSession.open`'s `target_color_space` parameter — raw-wasm
// always reports back the ACHIEVED tag, never assumes the request took, so
// this preference can never desync the display-encode primaries from the
// canvas tag (#1512) even if a browser silently declines the request.
//
// Fixed for a session's lifetime (same as the canvas dims): flipping the
// picker takes effect on the NEXT session open (asset switch / reload), not
// the next render tick — `WebPresentSurface` has no in-place reconfigure
// path (see `raw-gpu/src/present_chain_web.rs`).

import { Injectable, computed, signal } from '@angular/core';
import { STORAGE_KEYS, TypedStorage } from '../util/typed-storage';

export type CanvasColorSpace = 'display-p3' | 'srgb';

const VALUES: readonly CanvasColorSpace[] = ['display-p3', 'srgb'];

/** Runtime guard for the wire values — used everywhere a `CanvasColorSpace`
 * crosses a boundary this module doesn't fully control: `localStorage`
 * (`TypedStorage.get` returns unvalidated JSON — a stale value from an older
 * build, or hand-edited storage, must not silently become a "valid" choice)
 * and the Settings row's segmented-toggle change event (a `string`, not
 * statically narrowed to the option values it was built from). */
export function isCanvasColorSpace(value: unknown): value is CanvasColorSpace {
  return typeof value === 'string' && (VALUES as readonly string[]).includes(value);
}

/** True iff `matchMedia`, `window`, and the P3 gamut are all available and
 * this screen reports it. SSR-safe (falls back to `false`, same conservative
 * default `CanvasColorSpace.current`'s Swift counterpart uses before its
 * main-thread probe runs). */
function screenSupportsP3(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(color-gamut: p3)').matches;
  } catch {
    return false;
  }
}

/** Read + validate the stored choice — `null` on absent, corrupt, or
 * out-of-range storage, so `current()`'s `??` always falls through to the
 * gamut-probed default rather than propagating garbage into the WASM
 * session-open request. */
function loadStored(): CanvasColorSpace | null {
  const value = TypedStorage.get<unknown>(STORAGE_KEYS.CANVAS_COLOR_SPACE);
  return isCanvasColorSpace(value) ? value : null;
}

@Injectable({ providedIn: 'root' })
export class CanvasColorSpacePref {
  /** The stored choice, or `null` until this browser has ever touched the
   * picker (or the stored value fails `isCanvasColorSpace`). Read
   * synchronously in the field initializer (mirrors
   * `GpuLiveRenderGate.operatorEnabled`) so `current()` is correct from the
   * very first render, no async round-trip needed. */
  private readonly stored = signal<CanvasColorSpace | null>(loadStored());

  /** The effective preference: the stored choice, else the gamut-probed
   * default. A plain METHOD, not a `computed()` (Copilot review on #3224):
   * `screenSupportsP3()` reads `window.matchMedia`, which is not a reactive
   * Angular dependency, so a `computed` would memoize the FIRST gamut probe
   * forever and never re-check it — stale if the browser's reported gamut
   * changes later (e.g. the window moves to a different-capability display).
   * Every caller (`RawPipelineService.openLiveSession`, the Settings row)
   * already reads this imperatively per session-open / on init, not through
   * a template binding that needs change-detection tracking, so a method
   * that re-probes on every call is strictly more correct with no downside. */
  current(): CanvasColorSpace {
    return this.stored() ?? (screenSupportsP3() ? 'display-p3' : 'srgb');
  }

  /** Persist the user's choice and update the live signal immediately —
   * mirrors `GpuLiveRenderGate.apply`'s idempotent no-op-on-same-value shape. */
  set(value: CanvasColorSpace): void {
    if (this.stored() === value) return;
    this.stored.set(value);
    TypedStorage.set(STORAGE_KEYS.CANVAS_COLOR_SPACE, value);
  }

  /** Whether the user has explicitly chosen a value (vs. riding the
   * gamut-probed default) — the Settings row's provenance readout. */
  readonly isExplicit = computed(() => this.stored() !== null);
}
