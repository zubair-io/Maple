// The mask colour-range eyedropper, as one committed editor action (#362).
//
// Sibling of `editor-state.wb-sample.ts` and deliberately the same shape:
// arm, sample, write ONE model update so undo, the debounced sidecar write
// and render invalidation all see a single edit. It lives out of the session
// service because the interesting part — what a sample writes — is a pure
// map from a seed to the selected layer's range.

import type { AssetId } from '../../models/asset';
import type { AdjustmentModel } from '../../models/adjustment-model';
import type { LocalAdjustment } from '../../models/local-adjustment';
import type { MaskRangeSeed } from '../../raw-pipeline/raw-pipeline.sample-range.types';
import { RangeSampleRejected } from '../../raw-pipeline/raw-pipeline.sample-range.types';
import { defaultRangeRefinement, seededRange } from './mask-range';

/**
 * User-facing text for a rejected sample. Each rejection kind is a different
 * thing the photographer can do about it, so the message names the action.
 */
export function rangeSampleRejectionText(err: unknown): string {
  if (!(err instanceof RangeSampleRejected)) return 'The colour could not be sampled';
  switch (err.kind) {
    case 'neutral':
      return 'That area has no colour — pick a coloured area to select its range';
    case 'too_dark':
      return 'That area is too dark — pick a brighter coloured area';
    case 'outside_image':
      return 'Pick a point inside the image';
    case 'develop':
      return 'The colour could not be sampled';
  }
}

/**
 * The layer a seeded pick writes: the range re-centred on the sample. A
 * layer with no refinement yet is enabled by the pick itself — the
 * eyedropper IS the way to say "this colour", so it must not demand the
 * toggle first — starting from raw-core's defaults for width and feather.
 */
export function seededLayer(layer: LocalAdjustment, seed: MaskRangeSeed): LocalAdjustment {
  return { ...layer, range: seededRange(layer.range ?? defaultRangeRefinement(), seed) };
}

/**
 * The surface of the mask session + editor a sample reaches back into.
 * Declared structurally rather than importing the service, so this module
 * stays a leaf — the service imports it, not the other way round.
 */
export interface RangeSampleHost {
  focusedAssetId(): AssetId | null;
  currentAdjustment(id: AssetId): AdjustmentModel;
  assetExtension(id: AssetId): string;
  bytes(id: AssetId): Promise<Uint8Array>;
  serialize(model: AdjustmentModel): string;
  sampleMaskRange(
    bytes: Uint8Array,
    ext: string,
    xmp: string,
    nx: number,
    ny: number,
  ): Promise<MaskRangeSeed>;
  /** Rewrites the selected layer as ONE discrete (own-undo-entry) edit. */
  applySeed(seed: MaskRangeSeed): void;
  setMessage(text: string | null): void;
}

/**
 * Sample the colour at `(nx, ny)` and seed the selected layer's range with
 * it. Returns whether the seed was applied; a rejected click leaves the
 * model untouched and puts the reason in the panel's message.
 *
 * Every early return guards against writing to the wrong image: the sample
 * is a round trip through the worker, so the focused image may have changed
 * by the time the seed lands.
 */
export async function sampleMaskRangeInto(
  host: RangeSampleHost,
  nx: number,
  ny: number,
): Promise<boolean> {
  const id = host.focusedAssetId();
  if (!id) return false;
  host.setMessage(null);
  try {
    const bytes = await host.bytes(id);
    // The sampler develops its own probe from this model, so it must be the
    // model the canvas painted with — the click point is normalised against
    // the PAINTED raster (#3309).
    const xmp = host.serialize(host.currentAdjustment(id));
    const seed = await host.sampleMaskRange(bytes, host.assetExtension(id), xmp, nx, ny);
    if (host.focusedAssetId() !== id) return false;
    host.applySeed(seed);
    return true;
  } catch (err) {
    if (host.focusedAssetId() === id) host.setMessage(rangeSampleRejectionText(err));
    return false;
  }
}
