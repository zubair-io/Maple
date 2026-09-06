// Overlay coordinates for raw-core stages::geometry's normalized homography.
// Pixel resampling remains in Rust/WGSL; this maps only pointer/handle positions.
import type { AdjustmentModel } from '../../models/adjustment-model';

export type GeometrySettings = Pick<
  AdjustmentModel,
  'geoPerspectiveH' | 'geoPerspectiveV' | 'geoRotation' | 'geoAspect' | 'geoScale'
>;
type Point = { x: number; y: number };

export interface GeometryCoordinates {
  forward(point: Point): Point;
  inverse(point: Point): Point;
}

export function geometryCoordinates(
  model: GeometrySettings | undefined,
  width: number,
  height: number,
): GeometryCoordinates {
  if (!model) return { forward: (p) => p, inverse: (p) => p };
  const angle = (model.geoRotation * Math.PI) / 180;
  const aspect = Math.sqrt(model.geoAspect);
  const ratio = width / height;
  const a = Math.cos(angle) * model.geoScale * aspect;
  const b = (-Math.sin(angle) * model.geoScale) / aspect / ratio;
  const c = Math.sin(angle) * model.geoScale * aspect * ratio;
  const d = (Math.cos(angle) * model.geoScale) / aspect;
  const h = model.geoPerspectiveH;
  const v = model.geoPerspectiveV;
  return {
    forward(p) {
      const x = 2 * p.x - 1,
        y = 2 * p.y - 1;
      const z = h * x + v * y + 1;
      return { x: ((a * x + b * y) / z + 1) / 2, y: ((c * x + d * y) / z + 1) / 2 };
    },
    inverse(p) {
      const x = 2 * p.x - 1,
        y = 2 * p.y - 1;
      const z = (a - x * h) * (d - y * v) - (b - x * v) * (c - y * h);
      // The shared sampler renders points behind the projective plane black.
      // Keep them outside the mask frame, without leaking NaN into a drag.
      if (z <= 1e-8 || !Number.isFinite(z)) return { x: -1, y: -1 };
      return { x: ((d * x - b * y) / z + 1) / 2, y: ((a * y - c * x) / z + 1) / 2 };
    },
  };
}
