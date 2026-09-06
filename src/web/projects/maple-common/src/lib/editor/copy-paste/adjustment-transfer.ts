// Semantic source snapshot and target-specific transfer (#3311).
import type { AdjustmentModel } from '../../models/adjustment-model';
import {
  ADJUSTMENT_TRANSFER_MODES,
  CURRENT_WHITE_BALANCE_SCALE_VERSION,
  RELATIVE_TRANSFER_RANGES,
} from '../../generated/adjustment-transfer.generated';
import { buildGroupPatch, type AdjustmentGroupId } from './adjustment-groups';

export interface WhiteBalanceBaseline {
  temperature: number;
  tint: number;
}
export interface AdjustmentTransferRequest {
  sourceAssetId?: string;
  source: AdjustmentModel;
  groups: readonly AdjustmentGroupId[];
  relativeWhiteBalance: boolean;
  sourceBaseline?: WhiteBalanceBaseline;
}

/** Editor display coordinates, matching Swift's nearest-away-from-zero rounding. */
export function snapWhiteBalanceBaseline(value: WhiteBalanceBaseline): WhiteBalanceBaseline {
  return {
    temperature: Math.round(value.temperature / 50) * 50,
    tint: Math.sign(value.tint) * Math.round(Math.abs(value.tint)),
  };
}

function validBaseline(value: WhiteBalanceBaseline | undefined): value is WhiteBalanceBaseline {
  return (
    value !== undefined &&
    Number.isFinite(value.temperature) &&
    value.temperature > 0 &&
    Number.isFinite(value.tint)
  );
}

export function buildTransferPatch(
  request: AdjustmentTransferRequest,
  targetBaseline?: WhiteBalanceBaseline,
): Partial<AdjustmentModel> {
  const patch = buildGroupPatch(request.source, request.groups);
  if (!request.relativeWhiteBalance || !request.groups.includes('white_balance')) return patch;
  const correction = whiteBalanceCorrection(request);
  if (!validBaseline(targetBaseline))
    throw new Error('Cannot read this photo’s camera as-shot white balance.');
  for (const field of ['temperature', 'tint'] as const) {
    if (ADJUSTMENT_TRANSFER_MODES[field] !== 'Relative') continue;
    const [min, max] = RELATIVE_TRANSFER_RANGES[field];
    const value = targetBaseline[field] + correction[field];
    patch[field] = Math.max(min, Math.min(max, value));
  }
  return {
    ...patch,
    whiteBalancePreset: 'Custom',
    wbSource: 'Manual',
    wbScaleVersion: CURRENT_WHITE_BALANCE_SCALE_VERSION,
  };
}

/** Frozen correction in the v5 slider frame, relative to the actual camera baseline. */
export function whiteBalanceCorrection(request: AdjustmentTransferRequest): WhiteBalanceBaseline {
  if (request.source.wbScaleVersion !== CURRENT_WHITE_BALANCE_SCALE_VERSION)
    throw new Error(
      'Relative white balance requires a current-scale source. Reapply its white balance first.',
    );
  if (!validBaseline(request.sourceBaseline))
    throw new Error(
      'Cannot read camera as-shot white balance. Use absolute white balance or retry this photo.',
    );
  const source =
    request.source.wbSource === 'AsShot' || request.source.whiteBalancePreset === 'As Shot'
      ? request.sourceBaseline
      : request.source;
  const correction = {
    temperature: source.temperature - request.sourceBaseline.temperature,
    tint: source.tint - request.sourceBaseline.tint,
  };
  if (!Number.isFinite(correction.temperature) || !Number.isFinite(correction.tint))
    throw new Error('The source white balance is invalid.');
  return correction;
}

/** Before-values are real target sliders; after-values explicitly name the per-camera baseline. */
export function relativeWhiteBalanceDescription(
  request: AdjustmentTransferRequest,
  targets: readonly AdjustmentModel[],
): string {
  if (!request.sourceBaseline)
    return 'Read the source camera white balance to preview its correction.';
  try {
    const correction = whiteBalanceCorrection(request);
    const current = [
      ...new Set(
        targets.map((model) =>
          model.wbSource === 'AsShot' || model.whiteBalancePreset === 'As Shot'
            ? 'As Shot'
            : `${model.temperature} K, tint ${model.tint}`,
        ),
      ),
    ];
    const before = current.length === 1 ? current[0] : 'Mixed white balance';
    const signed = (value: number) => `${value >= 0 ? '+' : ''}${Number(value.toFixed(2))}`;
    return `${before} → each photo’s As Shot ${signed(correction.temperature)} K, tint ${signed(correction.tint)}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
