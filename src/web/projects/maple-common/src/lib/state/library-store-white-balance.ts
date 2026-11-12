import type { AdjustmentModel } from '../models/adjustment-model';
import type { AssetId } from '../models/asset';
import {
  hydratePartialWhiteBalance,
  type ImportedAutoPair,
  withResolvedImportedAuto,
} from '../models/partial-white-balance';

/** Each opened RAW's resolved name-only Auto pair (#4669), so any model that still
 * carries the intent (undo, restore, merge, Before/After) renders it without a
 * second estimate. Session-scoped, like the camera reading. */
export class ImportedAutoPairs {
  readonly byAsset = new Map<AssetId, ImportedAutoPair>();

  record(id: AssetId, pair: ImportedAutoPair): void {
    this.byAsset.set(id, { temperature: pair.temperature, tint: pair.tint });
  }

  apply(id: AssetId, model: AdjustmentModel): AdjustmentModel {
    const pair = this.byAsset.get(id);
    return pair ? withResolvedImportedAuto(model, pair) : model;
  }
}

/** Display hydration from the camera frame (absent axes; 6500/0 before a decode). */
export function hydrateCameraWhiteBalance(
  model: AdjustmentModel,
  reading: CameraWhiteBalanceReading | undefined,
): AdjustmentModel {
  const frame = reading?.frame;
  return hydratePartialWhiteBalance(model, frame?.temperature ?? 6500, frame?.tint ?? 0, !!frame);
}

export interface CameraWhiteBalanceReading {
  readonly temperature: number;
  readonly tint: number;
  readonly frame?: { readonly temperature: number; readonly tint: number };
}

/** Keep exact calibration coordinates for partial imports and slider-rounded
 * values for the established As-Shot reset control. Neither authors a sidecar. */
export function cameraWhiteBalanceReading(
  temperature: number,
  tint: number,
  calibrated: boolean,
): CameraWhiteBalanceReading {
  return {
    temperature: Math.round(temperature / 50) * 50,
    tint: Math.round(tint),
    ...(calibrated ? { frame: { temperature, tint } } : {}),
  };
}

export function seedWhiteBalanceModel(
  current: AdjustmentModel,
  reading: CameraWhiteBalanceReading,
): AdjustmentModel {
  if (current.partialWhiteBalance) {
    return hydratePartialWhiteBalance(
      current,
      reading.frame?.temperature ?? 6500,
      reading.frame?.tint ?? 0,
      !!reading.frame,
    );
  }
  const untouched =
    current.whiteBalancePreset === 'As Shot' &&
    Math.abs(current.temperature - 6500) < 0.5 &&
    Math.abs(current.tint) < 0.5;
  return untouched ? { ...current, temperature: reading.temperature, tint: reading.tint } : current;
}
