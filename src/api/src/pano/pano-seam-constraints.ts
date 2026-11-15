import { createHash } from 'node:crypto';

export interface SeamConstraintsRequest {
  version: 1;
  canvas: { width: number; height: number };
  regions: Array<{
    kind: 'include' | 'exclude';
    frame: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export class InvalidSeamConstraints extends Error {
  constructor(message: string) {
    super(`invalid_seam_constraints: ${message}`);
    this.name = 'invalid_seam_constraints';
  }
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidSeamConstraints('Expected an object.');
  }
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    throw new InvalidSeamConstraints(`Expected exactly ${keys.join(', ')}.`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum: number, maximum = 0xffffffff): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new InvalidSeamConstraints(`Expected an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function parseSeamConstraints(
  raw: unknown,
  frameCount: number,
): SeamConstraintsRequest | null {
  if (raw === undefined) return null;
  const request = object(raw, ['version', 'canvas', 'regions']);
  if (request.version !== 1) throw new InvalidSeamConstraints('Only version 1 is supported.');
  const canvas = object(request.canvas, ['width', 'height']);
  const width = integer(canvas.width, 1);
  const height = integer(canvas.height, 1);
  if (!Array.isArray(request.regions)) {
    throw new InvalidSeamConstraints('regions must be an array.');
  }
  const regions: SeamConstraintsRequest['regions'] = request.regions.map((rawRegion) => {
    const region = object(rawRegion, ['kind', 'frame', 'x', 'y', 'width', 'height']);
    if (region.kind !== 'include' && region.kind !== 'exclude') {
      throw new InvalidSeamConstraints('Region kind must be include or exclude.');
    }
    const frame = integer(region.frame, 0, frameCount - 1);
    const x = integer(region.x, 0);
    const y = integer(region.y, 0);
    const w = integer(region.width, 1);
    const h = integer(region.height, 1);
    if (x + w > width || y + h > height) {
      throw new InvalidSeamConstraints('Every region must lie wholly inside its reference canvas.');
    }
    return { kind: region.kind, frame, x, y, width: w, height: h };
  });
  return { version: 1, canvas: { width, height }, regions };
}

export function seamConstraintsRefusal(
  raw: unknown,
  frameCount: number,
  strategy: string | null | undefined,
  supported: boolean,
) {
  if (raw === undefined) return null;
  try {
    parseSeamConstraints(raw, frameCount);
    if (strategy === 'tile') {
      throw new InvalidSeamConstraints(
        'Seam constraints require graph-cut and cannot use tile strategy.',
      );
    }
  } catch (error) {
    if (!(error instanceof InvalidSeamConstraints)) throw error;
    return { status: 422, body: { error: error.name, message: error.message } };
  }
  return supported
    ? null
    : {
        status: 409,
        body: {
          error: 'pano_seam_constraints_unsupported',
          message: 'The configured maple-cli does not support SeamConstraintsRequest v1.',
        },
      };
}

export function seamConstraintsHash(raw: unknown): string | null {
  if (raw == null) return null;
  const normalized = parseSeamConstraints(raw, Number.MAX_SAFE_INTEGER);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function seamConstraintsResult(seamConstraints: SeamConstraintsRequest | undefined): {
  seamConstraints?: SeamConstraintsRequest;
} {
  return seamConstraints === undefined ? {} : { seamConstraints };
}
