import type { AssetId } from '../../models/asset';
import { isUnresolvedAuto } from '../../models/partial-white-balance';
import type { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import type { LibraryStateService } from '../../state/library-state.service';

/**
 * After the As Shot first frame, resolve a name-only imported Auto WB on the
 * worker session holding `bytes`, the RAW that frame was opened from (#4669):
 * at cold open, and again when such an intent becomes active on the open photo
 * (a variant, a history restore); the pipeline asks each session once. The pair
 * lands on the render/display model only, which re-renders once; a failure, or a
 * session another photo has replaced since, leaves As Shot on screen and the
 * next open retries. Final outputs never depend on it: they resolve in the core.
 */
export function resolveImportedAutoAfterFirstFrame(
  state: LibraryStateService,
  pipeline: RawPipelineService,
  assetId: AssetId,
  bytes: Uint8Array,
): void {
  if (!isUnresolvedAuto(state.adjustmentFor(assetId)().partialWhiteBalance)) return;
  pipeline.resolveImportedWhiteBalance(bytes).then(
    (pair) => state.resolveImportedAutoWhiteBalance(assetId, pair),
    () => undefined,
  );
}
