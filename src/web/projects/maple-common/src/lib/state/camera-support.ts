import {
  CAMERA_TIER_LABEL,
  CAMERA_TIER_EXPLANATION,
  FIXTURED_CAMERAS,
  LENS_SUPPORT_LABEL,
  LENS_SUPPORT_EXPLANATION,
  TIER_FOR_RESOLUTION,
  type CameraTier,
  type LensSupport,
  type ProfileResolution,
} from '../generated/camera-support.generated';

export interface CameraSupport {
  readonly cameraKey: string;
  readonly resolution: ProfileResolution;
  readonly lens: LensSupport;
  readonly tier: CameraTier;
  readonly label: string;
  readonly explanation: string;
  readonly lensLabel: string;
  readonly lensExplanation: string;
}

/** Parse facts supplied by the Rust resolver, never a camera-name heuristic.
 * Missing/older decode metadata means unassessed, not unsupported/qualified. */
export function cameraSupportFromJson(json: string | null | undefined): CameraSupport | undefined {
  if (!json) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    if (!isSupportWire(value)) return undefined;
    const resolved = TIER_FOR_RESOLUTION[value.resolution];
    const measured = FIXTURED_CAMERAS.find((body) => body.key === value.cameraKey);
    // Generated tier declaration order is worst to best, matching Rust/Swift/C#.
    const ranks = Object.keys(CAMERA_TIER_LABEL);
    const tier =
      measured && ranks.indexOf(resolved) >= ranks.indexOf(TIER_FOR_RESOLUTION[measured.resolution])
        ? measured.tier
        : resolved;
    return {
      ...value,
      tier,
      label: CAMERA_TIER_LABEL[tier],
      explanation: CAMERA_TIER_EXPLANATION[tier],
      lensLabel: LENS_SUPPORT_LABEL[value.lens],
      lensExplanation: LENS_SUPPORT_EXPLANATION[value.lens],
    };
  } catch {
    return undefined;
  }
}

function isSupportWire(value: unknown): value is {
  cameraKey: string;
  resolution: ProfileResolution;
  lens: LensSupport;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'cameraKey' in value &&
    typeof value.cameraKey === 'string' &&
    'resolution' in value &&
    typeof value.resolution === 'string' &&
    Object.hasOwn(TIER_FOR_RESOLUTION, value.resolution) &&
    'lens' in value &&
    typeof value.lens === 'string' &&
    Object.hasOwn(LENS_SUPPORT_LABEL, value.lens)
  );
}
