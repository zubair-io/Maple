// One committed AUTO recommendation, shared by the tone button and WB picker.
import type { EditorStateService } from './editor-state.service';
import type { AssetId } from '../models/asset';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { AutoAdjustPatch } from '../raw-pipeline/raw-pipeline.types';
import { ADJUSTMENT_RANGES } from '../generated/adjustment-tables.generated';
import { AUTO_WB_ALGORITHM_VERSION } from '../generated/white-balance-presets.generated';
import { isSupportedRaw } from '../state/raw-extensions';
import { stableStringify } from './edit-transaction';

export function autoAdjustmentPatch(
  result: AutoAdjustPatch,
  whiteBalanceOnly: boolean,
): Partial<AdjustmentModel> {
  const clamp = (field: keyof typeof ADJUSTMENT_RANGES, value: number): number => {
    const [min, max] = ADJUSTMENT_RANGES[field];
    return Math.min(max, Math.max(min, value));
  };
  return {
    ...(whiteBalanceOnly
      ? {}
      : {
          exposure: clamp('exposure', result.exposure),
          contrast: clamp('contrast', result.contrast),
          highlights: clamp('highlights', result.highlights),
          shadows: clamp('shadows', result.shadows),
          whites: clamp('whites', result.whites),
          blacks: clamp('blacks', result.blacks),
          autoExposure: 'Off' as const,
        }),
    temperature: clamp('temperature', result.temperature),
    tint: clamp('tint', result.tint),
    whiteBalancePreset: 'Auto',
    wbScaleVersion: 5,
    wbSource: 'Auto',
    wbSampleX: 0,
    wbSampleY: 0,
    wbAlgorithmVersion: AUTO_WB_ALGORITHM_VERSION,
  };
}

export async function applyAutoInto(
  editor: EditorStateService,
  id: AssetId,
  whiteBalanceOnly: boolean,
): Promise<boolean> {
  if (editor.autoInFlight() || editor.wbSampleInFlight()) return false;
  const before = editor.currentAdjustment();
  const history = editor.undoHistory();
  const asset = editor.library.assets().find((item) => item.id === id);
  if (editor.imageId() !== id || !before || !asset || !isSupportedRaw(asset.filename)) return false;
  // Both identities change on edits/undo or rebinding, so switching away and
  // back cannot revive an old recommendation even if the values match again.
  const stillCurrent = () =>
    editor.imageId() === id &&
    editor.currentAdjustment() === before &&
    editor.undoHistory() === history;
  editor.autoResult.set(null);
  editor.autoInFlight.set(true);
  try {
    const bytes = editor.library.bytesFor(id) ?? (await editor.library.bytesForAsset(id));
    if (!stillCurrent()) return false;
    const ext = asset.filename.split('.').pop()?.toLowerCase() ?? 'dng';
    const result = await editor.pipeline.computeAutoAdjustments(bytes, ext);
    if (!stillCurrent()) return false;
    if (!Object.values(result).every(Number.isFinite))
      throw new Error('Invalid AUTO recommendation');
    const patch = autoAdjustmentPatch(result, whiteBalanceOnly);
    if (stableStringify(before) === stableStringify({ ...before, ...patch })) return false;
    editor.commit('auto', whiteBalanceOnly ? 'Auto white balance' : 'Auto adjustments');
    editor.library.updateAdjustment(id, patch);
    editor.endEdit();
    const exposure = patch.exposure ?? before.exposure;
    editor.autoResult.set(
      whiteBalanceOnly
        ? `Auto white balance applied · ${Math.round(patch.temperature ?? 0)} K, tint ${Math.round(patch.tint ?? 0)}`
        : `Auto applied · Exposure ${exposure >= 0 ? '+' : ''}${exposure.toFixed(2)} EV`,
    );
    return true;
  } catch {
    if (stillCurrent()) editor.autoResult.set('Auto could not be applied');
    return false;
  } finally {
    editor.autoInFlight.set(false);
  }
}
