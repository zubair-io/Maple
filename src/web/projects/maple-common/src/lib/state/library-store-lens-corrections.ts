// library-store-lens-corrections.ts — per-asset decode-derived lens-correction
// capability signal (#3182): whether the focused RAW carries a DNG
// `OpcodeList3` at all, and whether its CA scale is a structural no-op
// (`raw_wasm`'s `MapleRender.has_lens_corrections`/`.lens_correction_ca_inert`,
// mirroring Apple's `EditSession.hasLensCorrections`/`.lensCorrectionCaInert`).
//
// Extracted out of `library-store.service.ts` to keep that file under the
// file-size budget headroom (tools/check-budget-headroom.sh, #2311's "split
// with real margin") — mirrors `library-store-dimensions.ts`'s
// `AssetDimensionBatcher` split: a small, self-contained signal + seeder that
// only needs its own Map.
//
// Signal-backed — unlike the plain-Map `asShotWb` (an imperative RESET-button
// read) — because `LensCorrectionsPanelComponent` is `OnPush` and reads
// through `computed()`: a plain Map getter would render once at the
// fail-closed default and never update once the decode that resolves the
// real capability lands after the panel has already painted.

import { signal, WritableSignal } from '@angular/core';
import { AssetId } from '../models/asset';

export interface LensCorrectionCapability {
  hasLensCorrections: boolean;
  lensCorrectionCaInert: boolean;
}

/**
 * Fail-closed default, matching `raw_wasm`'s own field defaults
 * (`develop_non_raw`'s hardcoded `false`/`true`) and Apple's `EditSession`
 * defaults: an asset with no decode yet (or a non-RAW asset) shows the Lens
 * Corrections panel disabled rather than falsely enabled.
 */
export const DEFAULT_LENS_CORRECTION_CAPABILITY: LensCorrectionCapability = {
  hasLensCorrections: false,
  lensCorrectionCaInert: true,
};

export class LensCorrectionCapabilities {
  readonly byAsset: WritableSignal<Map<AssetId, LensCorrectionCapability>> = signal(new Map());

  /**
   * Record the decode-time capability for `id` — call from the cold-open
   * call sites (`image-canvas.render2d.ts`'s `coldOpen2d`,
   * `image-canvas.gpu-present.ts`'s session open) right beside their
   * existing `seedAsShotWhiteBalance` call.
   */
  seed(id: AssetId, hasLensCorrections: boolean, lensCorrectionCaInert: boolean): void {
    this.byAsset.update((map) => {
      const next = new Map(map);
      next.set(id, { hasLensCorrections, lensCorrectionCaInert });
      return next;
    });
  }

  /**
   * Per-asset accessor — absent (no decode yet) reads as the fail-closed
   * default. Returns the raw value rather than wrapping it in a `computed()`
   * (Jules review on #3231): callers already read this from inside their OWN
   * `computed()` (`LensCorrectionsPanelComponent`'s `capabilities`), and
   * `this.byAsset()` is read synchronously here, so Angular's reactive graph
   * tracks the dependency on the outer computed without a second signal node
   * being allocated on every call.
   */
  for(id: AssetId): LensCorrectionCapability {
    return this.byAsset().get(id) ?? DEFAULT_LENS_CORRECTION_CAPABILITY;
  }
}
