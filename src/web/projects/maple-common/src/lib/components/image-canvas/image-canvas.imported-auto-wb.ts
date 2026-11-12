import type { AssetId } from '../../models/asset';
import { isUnresolvedAuto } from '../../models/partial-white-balance';
import type { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import type { LibraryStateService } from '../../state/library-state.service';

/**
 * After the As Shot first frame, resolve a name-only imported Auto WB once on the
 * retained session (#4669). The pair lands on the render/display model only, which
 * re-renders once; failure leaves As Shot on screen and the next open retries.
 */
export function resolveImportedAutoAfterFirstFrame(
  state: LibraryStateService,
  pipeline: RawPipelineService,
  assetId: AssetId,
): void {
  if (!isUnresolvedAuto(state.adjustmentFor(assetId)().partialWhiteBalance)) return;
  pipeline.resolveImportedWhiteBalance().then(
    (pair) => state.resolveImportedAutoWhiteBalance(assetId, pair),
    () => undefined,
  );
}
