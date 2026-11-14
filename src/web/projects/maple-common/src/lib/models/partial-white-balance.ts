import type { AdjustmentModel } from './adjustment-model';
import { authoredPairToV5, authoredTintToV4 } from '../xmp/xmp-wb-scale';
import { AUTO_WB_ALGORITHM_VERSION } from '../generated/white-balance-presets.generated';

/** Internal import intent (#3434), carried by undo snapshots, never a new XMP field.
 * Raw legacy coordinates stay intact until a camera frame can supply the absent axis.
 * Both axes absent is name-only Auto (#4669): As Shot until the opened RAW's session
 * resolves the shared estimator's pair, which `resolved` carries for rendering only. */
export interface PartialWhiteBalance {
  readonly temperature?: number;
  readonly tint?: number;
  readonly version: number;
  readonly resolved?: ImportedAutoPair;
}

/** The shared estimator's pair for a name-only Auto import (#4669). */
export interface ImportedAutoPair {
  readonly temperature: number;
  readonly tint: number;
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
  pair: ImportedAutoPair,
): AdjustmentModel {
  const imported = model.partialWhiteBalance;
  if (!imported || !isUnresolvedAuto(imported)) return model;
  return hydratePartialWhiteBalance(
    {
      ...model,
      wbSource: 'Auto',
      wbAlgorithmVersion: AUTO_WB_ALGORITHM_VERSION,
      partialWhiteBalance: { ...imported, resolved: { ...pair } },
    },
    pair.temperature,
    pair.tint,
    true,
  );
}

/** `model` with `reference`'s resolved name-only Auto pair (#4669), so a snapshot
 * taken before the estimate landed equals the same edit state after it. */
export function alignImportedAuto(
  model: AdjustmentModel,
  reference: AdjustmentModel,
): AdjustmentModel {
  const pair = reference.partialWhiteBalance?.resolved;
  return pair ? withResolvedImportedAuto(model, pair) : model;
}

/** The model a renderer consumes: a resolved name-only Auto renders as its
 * numeric pair, so every session (live, CPU, native detail) agrees without
 * estimating again. Stored sidecars never see this model. */
export function renderModelForImportedAuto(model: AdjustmentModel): AdjustmentModel {
  return model.partialWhiteBalance?.resolved ? { ...model, partialWhiteBalance: null } : model;
}

/** The model an interactive probe (eyedropper, range and curve samplers) develops: the
 * frame the canvas shows. A resolved name-only Auto is its pair; an unresolved one is
 * As Shot, since the core would otherwise resolve it to a different white balance than
 * the displayed raster the click was normalised against (#4669). */
export function probeModelForImportedAuto(model: AdjustmentModel): AdjustmentModel {
  return isUnresolvedAuto(model.partialWhiteBalance)
    ? { ...model, whiteBalancePreset: 'As Shot', partialWhiteBalance: null }
    : renderModelForImportedAuto(model);
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
