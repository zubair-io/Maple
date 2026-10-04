import type { AdjustmentModel } from '../../models/adjustment-model';
import type { CameraSupport } from '../../state/camera-support';
import { hasCalibratedWhiteBalance } from '../../state/camera-support';
import {
  cameraWhiteBalanceReading,
  seedWhiteBalanceModel,
} from '../../state/library-store-white-balance';

/** The model actually rendered by cold open, with its camera WB hydration.
 * A user edit made during decode is not part of these pixels (#4101). */
export function coldOpenRenderedModel(
  opened: AdjustmentModel,
  metadata: { asShotTemperature: number; asShotTint: number; cameraSupport?: CameraSupport },
): AdjustmentModel {
  return seedWhiteBalanceModel(
    opened,
    cameraWhiteBalanceReading(
      metadata.asShotTemperature,
      metadata.asShotTint,
      hasCalibratedWhiteBalance(metadata.cameraSupport),
    ),
  );
}
