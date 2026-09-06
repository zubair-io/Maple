import type { EditorStateService } from './editor-state.service';
import type { AssetId } from '../models/asset';
import type { AdjustmentModel } from '../models/adjustment-model';
import {
  WHITE_BALANCE_PRESET_VALUES,
  type WhiteBalancePreset,
} from '../generated/white-balance-presets.generated';
import { stableStringify } from './edit-transaction';

export async function applyWhiteBalancePresetInto(
  editor: EditorStateService,
  id: AssetId,
  preset: WhiteBalancePreset,
): Promise<boolean> {
  if (preset === 'Auto') return editor.applyAuto(id, true);
  const before = editor.currentAdjustment();
  if (editor.imageId() !== id || !before) return false;
  const pair =
    preset === 'As Shot' ? editor.library.asShotWbFor(id) : WHITE_BALANCE_PRESET_VALUES[preset];
  if (preset === 'As Shot' && !pair) return false;
  const patch: Partial<AdjustmentModel> = {
    ...pair,
    ...(pair ? { wbScaleVersion: 5 } : {}),
    whiteBalancePreset: preset,
    wbSource: preset === 'As Shot' ? 'AsShot' : preset === 'Custom' ? 'Manual' : 'Preset',
    wbSampleX: 0,
    wbSampleY: 0,
    wbAlgorithmVersion: 0,
  };
  if (stableStringify(before) === stableStringify({ ...before, ...patch })) return false;
  editor.commit('adjustment', `${preset} white balance`);
  editor.library.updateAdjustment(id, patch);
  editor.endEdit();
  return true;
}
