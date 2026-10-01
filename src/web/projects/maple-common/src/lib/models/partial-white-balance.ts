import type { AdjustmentModel } from './adjustment-model';
import { authoredPairToV5, authoredTintToV4 } from '../xmp/xmp-wb-scale';

/** Internal import intent (#3434), carried by undo snapshots, never a new XMP field.
 * Raw legacy coordinates stay intact until a camera frame can supply the absent axis. */
export interface PartialWhiteBalance {
  readonly temperature?: number;
  readonly tint?: number;
  readonly version: number;
}

/** Display hydration only. Serialization continues to use the original partial import.
 * Uncalibrated RAW / SDR and V1 keep the established post-DCP defaults. */
export function hydratePartialWhiteBalance(
  model: AdjustmentModel,
  temperature: number,
  tint: number,
  calibrated: boolean,
): AdjustmentModel {
  const imported = model.partialWhiteBalance;
  if (!imported || imported.version === 1) return model;
  if (!calibrated) {
    return {
      ...model,
      temperature: imported.temperature ?? 6500,
      tint: authoredTintToV4(imported.tint ?? 0, imported.version),
      wbScaleVersion: 5,
    };
  }
  const [resolvedTemperature, resolvedTint] = authoredPairToV5(
    imported.temperature ?? temperature,
    imported.tint ?? tint,
    imported.version,
  );
  return { ...model, temperature: resolvedTemperature, tint: resolvedTint, wbScaleVersion: 5 };
}

/** A user WB action supersedes imported intent. Complete undo snapshots explicitly
 * carry the state (including null), so replay restores it rather than authoring WB. */
export function whiteBalanceAuthoredPatch(
  patch: Partial<AdjustmentModel>,
): Partial<AdjustmentModel> {
  if ('partialWhiteBalance' in patch) return patch;
  return patch.temperature !== undefined ||
    patch.tint !== undefined ||
    patch.whiteBalancePreset !== undefined
    ? { ...patch, partialWhiteBalance: null }
    : patch;
}
