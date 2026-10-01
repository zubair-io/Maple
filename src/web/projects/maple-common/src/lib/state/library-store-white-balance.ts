import type { AdjustmentModel } from '../models/adjustment-model';
import { hydratePartialWhiteBalance } from '../models/partial-white-balance';

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
