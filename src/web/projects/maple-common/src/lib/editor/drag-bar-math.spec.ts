// drag-bar-math.spec.ts — responsive-program S5b (#625).
//
// Mirror of Apple's DragBarMathTests. Locks in cross-platform parity for
// the centerpiece UX primitive.

import {
  CENTER_TICK_INDEX,
  TICK_COUNT,
  clamp,
  didCrossZero,
  didReachExtreme,
  markerX,
  tickHeight,
  tickX,
  valueAtPointerX,
  valueDelta,
} from './drag-bar-math';

describe('DragBarMath', () => {
  describe('marker mapping', () => {
    it('places the marker at center for value 0', () => {
      expect(markerX(0, 250)).toBeCloseTo(125, 9);
    });

    it('pins to the right edge at +100', () => {
      expect(markerX(100, 250)).toBeCloseTo(250, 9);
    });

    it('pins to the left edge at -100', () => {
      expect(markerX(-100, 250)).toBeCloseTo(0, 9);
    });

    it('clamps out-of-range values', () => {
      expect(clamp(250)).toBe(100);
      expect(clamp(-250)).toBe(-100);
      expect(markerX(250, 100)).toBeCloseTo(100, 9);
      expect(markerX(-250, 100)).toBeCloseTo(0, 9);
    });

    it('inverts pointer x back to a value', () => {
      expect(valueAtPointerX(125, 250)).toBeCloseTo(0, 9);
      expect(valueAtPointerX(0, 250)).toBeCloseTo(-100, 9);
      expect(valueAtPointerX(250, 250)).toBeCloseTo(100, 9);
    });
  });

  describe('drag sensitivity', () => {
    it('bar drag: 50pt on a 250pt bar moves value by 40', () => {
      expect(valueDelta(50, 250, 'bar')).toBeCloseTo(40, 9);
    });

    it('canvas drag is half as sensitive as bar drag', () => {
      const dvBar = valueDelta(100, 250, 'bar');
      const dvCanvas = valueDelta(100, 250, 'canvas');
      expect(dvCanvas).toBeCloseTo(dvBar * 0.5, 9);
    });

    it('fine drag is quarter as sensitive as bar drag', () => {
      const dvBar = valueDelta(100, 250, 'bar');
      const dvFine = valueDelta(100, 250, 'fine');
      expect(dvFine).toBeCloseTo(dvBar * 0.25, 9);
    });

    it('returns zero delta when bar has no width', () => {
      expect(valueDelta(100, 0, 'bar')).toBe(0);
    });
  });

  describe('tick layout', () => {
    it('has 21 ticks with center at index 10', () => {
      expect(TICK_COUNT).toBe(21);
      expect(CENTER_TICK_INDEX).toBe(10);
      expect(tickHeight(10)).toBe(14);
      expect(tickHeight(0)).toBe(6);
      expect(tickHeight(20)).toBe(6);
    });

    it('pins edge ticks to bar bounds', () => {
      expect(tickX(0, 200)).toBeCloseTo(0, 9);
      expect(tickX(20, 200)).toBeCloseTo(200, 9);
      expect(tickX(10, 200)).toBeCloseTo(100, 9);
    });

    it('rejects out-of-range tick indices', () => {
      expect(() => tickX(-1, 100)).toThrow();
      expect(() => tickX(21, 100)).toThrow();
    });
  });

  describe('haptic predicates', () => {
    it('fires zero-cross on sign change', () => {
      expect(didCrossZero(-1, 1)).toBe(true);
      expect(didCrossZero(5, -5)).toBe(true);
      expect(didCrossZero(5, 10)).toBe(false);
      expect(didCrossZero(-5, -10)).toBe(false);
    });

    it('fires extreme when landing on the boundary', () => {
      expect(didReachExtreme(95, 100)).toBe(true);
      expect(didReachExtreme(-50, -100)).toBe(true);
      expect(didReachExtreme(100, 100)).toBe(false);
      expect(didReachExtreme(50, 60)).toBe(false);
    });
  });
});
