// Neutral white-balance sampling, as one committed editor action (#2434).
//
// Sibling of `EditorStateService.applyAuto` and deliberately the same shape:
// arm, sample, apply ONE `updateAdjustment` so undo, the debounced sidecar
// write, and render invalidation all see a single edit. It lives out here
// rather than on the service because that file is close to its size budget,
// and because the interesting part — what a sample writes — is a pure map
// from a `WbSampleResult` and a click point to a slider patch.

import type { WritableSignal } from '@angular/core';
import type { AssetId } from '../models/asset';
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

/**
 * The surface of `EditorStateService` a sample reaches back into. Declared
 * structurally rather than importing the service, so this module stays a
 * leaf — the service imports it, not the other way round.
 */
export interface WbSampleHost {
  imageId(): AssetId | null;
  currentAdjustment(): AdjustmentModel | null;
  wbSampleInFlight: WritableSignal<boolean>;
  autoResult: WritableSignal<string | null>;
  commit(): void;
  library: {
    bytesFor(id: AssetId): Uint8Array | undefined;
    bytesForAsset(id: AssetId): Promise<Uint8Array>;
    assets(): readonly { id: AssetId; filename: string }[];
    updateAdjustment(id: AssetId, patch: Partial<AdjustmentModel>): void;
  };
  pipeline: {
    sampleWhiteBalance(
      bytes: Uint8Array,
      ext: string,
      xmp: string | undefined,
      nx: number,
      ny: number,
    ): Promise<WbSampleResult>;
  };
}

/**
 * Sample the neutral at `(nx, ny)` and apply it to `id` as one committed
 * action. Body of `EditorStateService.sampleWhiteBalanceAt`.
 *
 * Every early return is a guard against writing to the wrong image: a second
 * arm while one sample is in flight, and — because the sample is a round trip
 * through the worker — the focused image having changed by the time the
 * result lands.
 */
export async function sampleWhiteBalanceInto(
  host: WbSampleHost,
  id: AssetId,
  nx: number,
  ny: number,
): Promise<boolean> {
  if (host.wbSampleInFlight()) return false;
  if (host.imageId() !== id || host.currentAdjustment() == null) return false;
  host.autoResult.set(null);
  host.wbSampleInFlight.set(true);
  try {
    const bytes = host.library.bytesFor(id) ?? (await host.library.bytesForAsset(id));
    const asset = host.library.assets().find((a) => a.id === id);
    const ext = asset?.filename.split('.').pop()?.toLowerCase() ?? 'dng';
    const sample = await host.pipeline.sampleWhiteBalance(bytes, ext, undefined, nx, ny);
    if (host.imageId() !== id) return false;
    host.commit();
    host.library.updateAdjustment(id, sampledWbPatch(sample, nx, ny));
    host.autoResult.set(
      `White balance sampled · ${Math.round(sample.temperature)} K, tint ${Math.round(sample.tint)}`,
    );
    return true;
  } catch (err) {
    if (host.imageId() === id) host.autoResult.set(wbSampleRejectionText(err));
    return false;
  } finally {
    host.wbSampleInFlight.set(false);
  }
}
