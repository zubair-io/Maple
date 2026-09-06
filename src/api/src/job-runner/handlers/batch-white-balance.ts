import { ffiPool } from '../../ffi/ffi-pool.ts';
import {
  CURRENT_WHITE_BALANCE_SCALE_VERSION,
  RELATIVE_TRANSFER_RANGES,
} from '../../generated/adjustment-transfer.generated.ts';
import type { XmpTransferPatch } from '../../xmp/transfer-patch.ts';

export interface WhiteBalanceCorrection {
  temperature: number;
  tint: number;
}

export function parseWhiteBalanceCorrection(value: unknown): WhiteBalanceCorrection | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    !('temperature' in value) ||
    !('tint' in value) ||
    typeof value.temperature !== 'number' ||
    typeof value.tint !== 'number' ||
    !Number.isFinite(value.temperature) ||
    !Number.isFinite(value.tint)
  ) {
    throw new Error('Relative white balance requires a finite camera-baseline correction');
  }
  return { temperature: value.temperature, tint: value.tint };
}

/** Uses the same native estimator and slider quantization as Apple and browser decode. */
export async function cameraBaseline(path: string): Promise<WhiteBalanceCorrection> {
  const baseline = await ffiPool().asShotWhiteBalance(path);
  return {
    temperature: Math.round(baseline.temperature / 50) * 50,
    tint: Math.sign(baseline.tint) * Math.round(Math.abs(baseline.tint)),
  };
}

export async function relativeWhiteBalancePatch(
  path: string,
  patch: XmpTransferPatch,
  correction?: WhiteBalanceCorrection,
): Promise<XmpTransferPatch> {
  if (!correction) return patch;
  const baseline = await cameraBaseline(path);
  const value = (field: 'temperature' | 'tint') => {
    const [min, max] = RELATIVE_TRANSFER_RANGES[field];
    return String(Math.max(min, Math.min(max, baseline[field] + correction[field])));
  };
  return {
    ...patch,
    attributes: {
      ...patch.attributes,
      'crs:Temperature': value('temperature'),
      'crs:Tint': value('tint'),
      'crs:WhiteBalance': 'Custom',
      'papp:WbScaleVersion': String(CURRENT_WHITE_BALANCE_SCALE_VERSION),
      'papp:WbSource': 'Manual',
      'papp:WbSampleX': null,
      'papp:WbSampleY': null,
      'papp:WbAlgorithmVersion': null,
    },
  };
}
