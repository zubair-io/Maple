// Neutral white-balance sampling, as one committed editor action (#2434).
//
// Sibling of `EditorStateService.applyAuto` and deliberately the same shape:
// arm, sample, apply ONE `updateAdjustment` so undo, the debounced sidecar
// write, and render invalidation all see a single edit. It lives out here
// rather than on the service because that file is close to its size budget,
// and because the interesting part — what a sample writes — is a pure map
// from a `WbSampleResult` and a click point to a slider patch.

import type { AdjustmentModel } from '../models/adjustment-model';
import type { WbSampleResult } from '../raw-pipeline/raw-pipeline.sample-wb.types';
import { WbSampleRejected } from '../raw-pipeline/raw-pipeline.sample-wb.types';

/**
 * The patch a committed sample writes: the pair the sampler solved plus the
 * provenance that makes it reproducible — where it was picked and which
 * version of the derivation produced it (`wb_algorithm_version`).
 *
 * `wbSource` moves to `Sampled`, which is what the UI reads back to say the
 * white balance came from a click rather than the camera.
 */
export function sampledWbPatch(
  sample: WbSampleResult,
  nx: number,
  ny: number,
): Partial<AdjustmentModel> {
  return {
    temperature: sample.temperature,
    tint: sample.tint,
    wbSource: 'Sampled',
    wbSampleX: nx,
    wbSampleY: ny,
    wbAlgorithmVersion: sample.algorithmVersion,
  };
}

/**
 * User-facing text for a rejected sample. Each rejection kind is a different
 * thing the photographer can do about it, so the message names the action —
 * never "sampling failed".
 */
export function wbSampleRejectionText(err: unknown): string {
  if (!(err instanceof WbSampleRejected)) return 'White balance could not be sampled';
  switch (err.kind) {
    case 'clipped':
      return 'That surface is blown out — pick a darker neutral';
    case 'too_dark':
      return 'That surface is too dark — pick a brighter neutral';
    case 'out_of_domain':
      return 'That surface is not a plausible neutral — pick a grey or white one';
    case 'outside_image':
      return 'Pick a point inside the image';
    case 'develop':
      return 'White balance could not be sampled';
  }
}
