import type { AdjustmentModel } from './adjustment-model';
import { authoredPairToV5, authoredTintToV4 } from '../xmp/xmp-wb-scale';

/** Internal import intent (#3434), carried by undo snapshots, never a new XMP field.
 * Raw legacy coordinates stay intact until a camera frame can supply the absent axis.
 * Both axes absent is name-only Auto (#4669): As Shot until the opened RAW's session
 * resolves the shared estimator's pair, which `resolved` carries for rendering only. */
export interface PartialWhiteBalance {
  readonly temperature?: number;
  readonly tint?: number;
  readonly version: number;
  readonly resolved?: { readonly temperature: number; readonly tint: number };
}

export function isUnresolvedAuto(imported: PartialWhiteBalance | null | undefined): boolean {
  return (
    !!imported &&
    imported.temperature === undefined &&
    imported.tint === undefined &&
    !imported.resolved
  );
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
  if (imported?.resolved) return { ...model, ...imported.resolved, wbScaleVersion: 5 };
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

/** Carry a session's resolved name-only Auto pair (#4669). The sidecar keeps its
 * intent; any other model is unchanged. */
export function withResolvedImportedAuto(
  model: AdjustmentModel,
  pair: { readonly temperature: number; readonly tint: number },
): AdjustmentModel {
  const imported = model.partialWhiteBalance;
  if (!imported || !isUnresolvedAuto(imported)) return model;
  return hydratePartialWhiteBalance(
    { ...model, partialWhiteBalance: { ...imported, resolved: { ...pair } } },
    pair.temperature,
    pair.tint,
    true,
  );
}

/** The model a renderer consumes: a resolved name-only Auto renders as its
 * numeric pair, so every session (live, CPU, native detail) agrees without
 * estimating again. Stored sidecars never see this model. */
export function renderModelForImportedAuto(model: AdjustmentModel): AdjustmentModel {
  return model.partialWhiteBalance?.resolved ? { ...model, partialWhiteBalance: null } : model;
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
