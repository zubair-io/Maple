import type { AssetId } from '../../models/asset';
import type { AdjustmentModel } from '../../models/adjustment-model';
import { isDefaultAdjustment } from '../../models/adjustment-model';
import type { RemovalCompanionBundle } from '../../removal/removal-companion-bundle';
import { savedRemovalRecords } from '../../removal/saved-removal-records';
import type { SavedRemovalRenderService } from '../../removal/saved-removal-render.service';

/** Resolve saved patches only when a RAW session opens, never on slider ticks. */
export async function loadGpuSessionRemovals(
  assetId: AssetId,
  model: AdjustmentModel,
  serialize: (model: AdjustmentModel) => string,
  service: SavedRemovalRenderService,
): Promise<{
  readonly xmp: string | undefined;
  readonly saved: RemovalCompanionBundle | undefined;
}> {
  const xml = serialize(model);
  const xmp = isDefaultAdjustment(model) && !savedRemovalRecords(xml) ? undefined : xml;
  return { xmp, saved: await service.load(assetId, xml) };
}
