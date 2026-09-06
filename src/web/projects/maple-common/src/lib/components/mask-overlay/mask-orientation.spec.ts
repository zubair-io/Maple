import { describe, expect, it } from 'vitest';
import { defaultAdjustmentModel, defaultCrop } from '../../models/adjustment-model';
import { geometryCoordinates } from '../editor/geometry-coordinates';
import {
  applyAffine,
  evaluateMaskWeight,
  hitTestMaskHandle,
  makeMaskCanvasMap,
  maskFromNormalizedDisplay,
  maskFromScreen,
  maskToScreen,
} from './mask-geometry';
import type { LocalMask } from '../../models/local-adjustment';

const footprint = { left: 20, top: 30, width: 600, height: 400 };
const source = { x: 0.2, y: 0.3 };
const oriented = [
  [0.2, 0.3],
  [0.8, 0.3],
  [0.8, 0.7],
  [0.2, 0.7],
  [0.3, 0.2],
  [0.7, 0.2],
  [0.7, 0.8],
  [0.3, 0.8],
];

describe('sensor mask coordinates through EXIF orientation', () => {
  for (let tag = 1; tag <= 8; tag++) {
    it(`maps EXIF ${tag} to its independently specified display point`, () => {
      const map = makeMaskCanvasMap(footprint, defaultCrop(), 6000, 4000, tag);
      const screen = maskToScreen(map, source);
      expect(screen.x).toBeCloseTo(20 + oriented[tag - 1][0] * 600, 8);
      expect(screen.y).toBeCloseTo(30 + oriented[tag - 1][1] * 400, 8);
      expect(maskFromScreen(map, screen.x, screen.y).x).toBeCloseTo(source.x, 8);
      expect(maskFromScreen(map, screen.x, screen.y).y).toBeCloseTo(source.y, 8);
    });

    it(`composes EXIF ${tag} before perspective, rotation and angled crop`, () => {
      const [w, h] = tag >= 5 ? [4000, 6000] : [6000, 4000];
      const map = makeMaskCanvasMap(
        footprint,
        { left: 0.08, top: 0.1, right: 0.95, bottom: 0.9, angle: 7 },
        w,
        h,
        tag,
      );
      map.geometry = geometryCoordinates(
        {
          ...defaultAdjustmentModel(),
          geoPerspectiveH: 0.2,
          geoPerspectiveV: -0.13,
          geoRotation: 11,
          geoAspect: 1.2,
          geoScale: 1.1,
        },
        w,
        h,
      );
      const expected = applyAffine(
        map.fullToCrop,
        map.geometry.forward({
          x: oriented[tag - 1][0],
          y: oriented[tag - 1][1],
        }),
      );
      const screen = maskToScreen(map, source);
      expect(screen.x).toBeCloseTo(20 + expected.x * 600, 8);
      expect(screen.y).toBeCloseTo(30 + expected.y * 400, 8);
      const restored = maskFromScreen(map, screen.x, screen.y);
      expect(restored.x).toBeCloseTo(source.x, 8);
      expect(restored.y).toBeCloseTo(source.y, 8);
      const mask: LocalMask = {
        kind: 'linear',
        start: source,
        end: { x: 0.75, y: 0.65 },
        feather: 0.7,
      };
      expect(hitTestMaskHandle(screen.x, screen.y, mask, map, 5)).toBe('linearStart');
      const tint = maskFromNormalizedDisplay(map, expected);
      expect(evaluateMaskWeight(mask, tint.x, tint.y)).toBeCloseTo(
        evaluateMaskWeight(mask, source.x, source.y),
        8,
      );
    });
  }

  it('keeps already oriented non-RAW pixels and absent metadata at identity', () => {
    for (const orientation of [undefined, 1, 0, 9, NaN]) {
      const map = makeMaskCanvasMap(footprint, defaultCrop(), 6000, 4000, orientation);
      expect(maskToScreen(map, source)).toEqual({ x: 140, y: 150 });
    }
  });
});
