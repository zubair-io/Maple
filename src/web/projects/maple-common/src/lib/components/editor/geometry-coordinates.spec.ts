import { describe, expect, it } from 'vitest';
import { defaultAdjustmentModel, defaultCrop } from '../../models/adjustment-model';
import { geometryCoordinates } from './geometry-coordinates';
import { makeMaskCanvasMap, maskFromScreen, maskToScreen } from '../mask-overlay/mask-geometry';

describe('manual geometry overlay coordinates', () => {
  it('keeps stored mask coordinates stable through geometry and crop', () => {
    const geometry = geometryCoordinates(
      {
        ...defaultAdjustmentModel(),
        geoPerspectiveH: 0.3,
        geoPerspectiveV: -0.2,
        geoRotation: 17,
        geoAspect: 1.3,
        geoScale: 1.2,
      },
      6000,
      4000,
    );
    const map = makeMaskCanvasMap(
      { left: 10, top: 20, width: 600, height: 400 },
      { ...defaultCrop(), left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, angle: 3 },
      6000,
      4000,
    );
    map.geometry = geometry;
    for (const point of [
      { x: 0.25, y: 0.75 },
      { x: 0.5, y: 0.5 },
    ]) {
      const screen = maskToScreen(map, point);
      const restored = maskFromScreen(map, screen.x, screen.y);
      expect(restored.x).toBeCloseTo(point.x, 8);
      expect(restored.y).toBeCloseTo(point.y, 8);
    }
  });
  it('rotates clockwise in pixel units on a rectangular frame', () => {
    const geometry = geometryCoordinates(
      { ...defaultAdjustmentModel(), geoRotation: 90 },
      6000,
      4000,
    );
    expect(geometry.forward({ x: 0.6, y: 0.5 }).x).toBeCloseTo(0.5);
    expect(geometry.forward({ x: 0.6, y: 0.5 }).y).toBeCloseTo(0.65);
  });
});
