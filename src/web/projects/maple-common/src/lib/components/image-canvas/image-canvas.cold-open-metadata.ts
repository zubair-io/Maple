import type { LibraryStateService } from '../../state/library-state.service';
import type { AssetId } from '../../models/asset';
import type { OpenedLiveSession } from '../../raw-pipeline/raw-pipeline.service';
import { hasCalibratedWhiteBalance } from '../../state/camera-support';
import type { CameraSupport } from '../../state/camera-support';
import type { LensProfileResolution } from '../../lens/lens-profile.types';

/** Publish the camera assessment shared by CPU decode and GPU session open.
 * The caller records native dimensions first, then frame intent before opening the edit gate. */
export function seedColdOpenMetadata(
  state: LibraryStateService,
  assetId: AssetId,
  fitRevision: number,
  reply: Pick<
    OpenedLiveSession,
    | 'asShotTemperature'
    | 'asShotTint'
    | 'cameraSupport'
    | 'hasLensCorrections'
    | 'lensCorrectionCaInert'
    | 'lensProfile'
    | 'autoFit'
  >,
): void {
  state.seedAsShotWhiteBalance(
    assetId,
    reply.asShotTemperature,
    reply.asShotTint,
    hasCalibratedWhiteBalance(reply.cameraSupport),
  );
  const support = decodeSupportFrom(reply);
  state.seedLensCorrections(
    assetId,
    support.hasLensCorrections,
    support.lensCorrectionCaInert,
    support.cameraSupport,
    support.lensProfile,
    reply.autoFit,
    fitRevision,
  );
}

/**
 * #3182 fallback defaults for a decode/session-open reply that predates the
 * lens-correction fields (older worker builds, minimal test fakes): no known
 * corrections ⇒ the panel reads as disabled, CA reads as inert. Shared by the
 * 2D cold open and the GPU live-session open (`image-canvas.gpu-present.ts`).
 * A decode without camera metadata explicitly clears any prior assessment,
 * and one without an imported-profile verdict (#3479) clears that too.
 */
function decodeSupportFrom(reply: {
  hasLensCorrections?: boolean;
  lensCorrectionCaInert?: boolean;
  cameraSupport?: CameraSupport;
  lensProfile?: LensProfileResolution;
}): {
  hasLensCorrections: boolean;
  lensCorrectionCaInert: boolean;
  cameraSupport: CameraSupport | null;
  lensProfile: LensProfileResolution | null;
} {
  return {
    hasLensCorrections: reply.hasLensCorrections ?? false,
    lensCorrectionCaInert: reply.lensCorrectionCaInert ?? true,
    cameraSupport: reply.cameraSupport ?? null,
    lensProfile: reply.lensProfile ?? null,
  };
}
