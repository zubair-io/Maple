import type { AssetId } from '../../models/asset';
import type { LibraryStateService } from '../../state/library-state.service';

/** A failed current request settles pending provenance, preserving a completed fit. */
export function settleFailedAutoFit(
  host: {
    readonly state: LibraryStateService;
    readonly currentAssetId: AssetId | null;
    readonly renderGeneration: number;
  },
  assetId: AssetId | null,
  generation: number,
  fitRevision: number | undefined,
): void {
  if (
    !assetId ||
    assetId !== host.currentAssetId ||
    generation !== host.renderGeneration ||
    fitRevision !== host.state.autoFitRevisionFor(assetId) ||
    host.state.adjustmentFor(assetId)().profile !== 'Auto'
  )
    return;
  const capabilities = host.state.lensCorrectionsFor(assetId);
  if (capabilities.autoFit === undefined)
    host.state.seedLensProfile(assetId, capabilities.lensProfile ?? null, false, fitRevision);
}
